/**
 * @license Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/* eslint-disable no-console */
const path = require('path');
const parseURL = require('url').parse;

const mkdirp = require('mkdirp');
const args = require('yargs')
    .wrap(Math.min(process.stdout.columns, 120))
    .help('help')
    .usage('node $0 [options]')
    .example('node $0 -n 3 --sites-path ./sample-sites.json')
    .example('node $0 --site https://google.com/')
    .example('node $0 --subset')
    .describe({
      'out': 'Custom out path',
      'n': 'Number of runs per site',
      'reuse-chrome': 'Reuse the same Chrome instance across all site runs',
      'keep-first-run': 'If you use --reuse-chrome, by default the first run results are discarded',
    })
    .default('n', 3)
    .group(
        ['disable-device-emulation', 'disable-cpu-throttling', 'disable-network-throttling'],
        'Lighthouse settings:')
    .boolean(['disable-device-emulation', 'disable-cpu-throttling', 'disable-network-throttling'])
    .describe({
      'disable-device-emulation': 'Disable Nexus 5X emulation',
      'disable-cpu-throttling': 'Disable CPU throttling',
      'disable-network-throttling': 'Disable network throttling',
    })
    .group(['sites-path', 'subset', 'site'], 'Options to specify sites:')
    .describe({
      'sites-path': 'Include relative path of a json file with urls to run',
      'subset': 'Measure a subset of popular sites',
      'site': 'Include a specific site url to run',
    })
    .default('sites-path', 'sites.js')
    .argv;

const constants = require('./constants.js');
const utils = require('./utils.js');
const config = require('../lighthouse-core/config/plots-config.js');
const lighthouse = require('../lighthouse-core/index.js');
const ChromeLauncher = require('chrome-launcher');
const Printer = require('../lighthouse-cli/printer');
const assetSaver = require('../lighthouse-core/lib/asset-saver.js');

const keepFirstRun = args.keepFirstRun || !args.reuseChrome;
const outPath = generateOutPath();

/**
 * @return {string}
 */
function generateOutPath() {
  if (args.out) {
    return path.resolve(__dirname, args.out);
  }
  const date = new Date().toISOString();
  return path.resolve(__dirname, `out-${sanitize(date)}`);
}

function getUrls() {
  if (args.site) {
    return [args.site];
  }

  if (args.subset) {
    return require(path.resolve(__dirname, 'sites_subset.js'));
  }

  return require(path.resolve(__dirname, args.sitesPath));
}

const URLS = getUrls();

function main() {
  if (args.n === 1 && !keepFirstRun) {
    console.log('ERROR: You are only doing one run and re-using chrome');
    console.log('but did not specify --keep-first-run');
    return;
  }

  console.log('Using out folder:', path.basename(outPath));

  if (args.reuseChrome) {
    ChromeLauncher.launch().then(launcher => {
      return runAnalysisWithExistingChromeInstances(launcher)
        .catch(handleError)
        .then(() => launcher.kill());
    });
    return;
  }
  runAnalysisWithNewChromeInstances();
}

main();

/**
 * Launches a new Chrome instance for each site run.
 * Returns a promise chain that analyzes all the sites n times.
 * @return {!Promise}
 */
function runAnalysisWithNewChromeInstances() {
  let promise = Promise.resolve();

  for (let i = 0; i < args.n; i++) {
    // Averages out any order-dependent effects such as memory pressure
    utils.shuffle(URLS);

    const isFirstRun = i === 0;
    const ignoreRun = keepFirstRun ? false : isFirstRun;
    for (const url of URLS) {
      promise = promise.then(() => {
        return ChromeLauncher.launch().then(launcher => {
          return singleRunAnalysis(url, launcher, {ignoreRun})
            .catch(handleError)
            .then(() => launcher.kill());
        }).catch(handleError);
      });
    }
  }
  return promise;
}

/**
 * @param {!Error} error
 */
function handleError(error) {
  console.error(error);
  if (process.env.CI) {
    process.exit(1);
  }
}

/**
 * Reuses existing Chrome instance for all site runs.
 * Returns a promise chain that analyzes all the sites n times.
 * @param {!Launcher} launcher
 * @return {!Promise}
 */
function runAnalysisWithExistingChromeInstances(launcher) {
  let promise = Promise.resolve();

  for (let i = 0; i < args.n; i++) {
    // Averages out any order-dependent effects such as memory pressure
    utils.shuffle(URLS);

    const isFirstRun = i === 0;
    const ignoreRun = keepFirstRun ? false : isFirstRun;
    for (const url of URLS) {
      promise = promise.then(() => singleRunAnalysis(url, launcher, {ignoreRun}));
    }
  }
  return promise;
}

/**
 * Analyzes a site a single time using lighthouse.
 * @param {string} url
 * @param {!Launcher} launcher
 * @param {{ignoreRun: boolean}} options
 * @return {!Promise}
 */
function singleRunAnalysis(url, launcher, {ignoreRun}) {
  const id = sanitize(new Date().toISOString());
  console.log('Measuring site:', url, 'run:', id);
  const parsedURL = parseURL(url);
  const urlBasedFilename = sanitize(`${parsedURL.host}-${parsedURL.pathname}`);
  const runPath = path.resolve(outPath, urlBasedFilename, id);
  if (!ignoreRun) {
    mkdirp.sync(runPath);
  }
  const outputPath = path.resolve(runPath, constants.LIGHTHOUSE_RESULTS_FILENAME);
  const assetsPath = path.resolve(runPath, 'assets');
  return analyzeWithLighthouse(launcher, url, outputPath, assetsPath, {ignoreRun});
}

/**
 * Runs lighthouse and save the artifacts (not used directly by plots,
 * but may be helpful for debugging outlier runs).
 * @param {!Launcher} launcher
 * @param {string} url
 * @param {string} outputPath
 * @param {string} assetsPath
 * @param {{ignoreRun: boolean}} options
 * @return {!Promise}
 */
function analyzeWithLighthouse(launcher, url, outputPath, assetsPath, {ignoreRun}) {
  const flags = {
    output: 'json',
    disableCpuThrottling: ignoreRun ? true : args.disableCpuThrottling,
    disableNetworkThrottling: ignoreRun ? true : args.disableNetworkThrottling,
    disableDeviceEmulation: args.disableDeviceEmulation,
    port: launcher.port,
  };
  return lighthouse(url, flags, config)
    .then(lighthouseResults => {
      if (ignoreRun) {
        console.log('First load of site. Results not being saved to disk.');
        return;
      }
      return assetSaver
          .saveAssets(lighthouseResults.artifacts, lighthouseResults.audits, assetsPath)
        .then(() => {
          lighthouseResults.artifacts = undefined;
          return Printer.write(lighthouseResults, flags.output, outputPath);
        });
    })
    .catch(handleError);
}

/**
 * Converts a URL into a filename-friendly string
 * @param {string} string
 * @return {string}
 */
function sanitize(string) {
  const illegalRe = /[/?<>\\:*|":]/g;
  const controlRe = /[\x00-\x1f\x80-\x9f]/g; // eslint-disable-line no-control-regex
  const reservedRe = /^\.+$/;

  return string
      .replace(illegalRe, '.')
      .replace(controlRe, '\u2022')
      .replace(reservedRe, '')
      .replace(/\s+/g, '_');
}
