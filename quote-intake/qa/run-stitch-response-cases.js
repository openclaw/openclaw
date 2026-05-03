#!/usr/bin/env node

const path = require('path');
const { loadFixtures } = require('./evaluator');
const { evaluateResponse, readResponse } = require('./stitch-response-evaluator');

function run() {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  const fixtures = loadFixtures(fixturesDir);
  const results = fixtures.map((fixture) => {
    const response = readResponse(fixturesDir, fixture);
    const evaluation = evaluateResponse(fixture, response.text);
    return { fixture, response, evaluation };
  });

  const passed = results.filter((result) => result.evaluation.ok).length;
  const failed = results.length - passed;

  console.log(`Stitch Response QA: ${passed}/${results.length} passed`);
  console.log('');

  results.forEach((result) => {
    const marker = result.evaluation.ok ? 'PASS' : 'FAIL';
    console.log(`${marker} ${result.fixture.id}: ${result.fixture.name}`);
    if (!result.evaluation.ok) {
      result.evaluation.failures.forEach((failure) => {
        console.log(`  - ${failure}`);
      });
      console.log(`  response: ${result.response.filePath}`);
    }
  });

  if (failed > 0) {
    process.exitCode = 1;
  }
}

run();
