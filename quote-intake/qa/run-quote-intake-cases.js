#!/usr/bin/env node

const path = require('path');
const { buildQuoteIntake } = require('../index');
const { analyzePacket, evaluateAnalysis, loadFixtures } = require('./evaluator');

async function run() {
  const fixturesDir = path.join(__dirname, '..', 'fixtures');
  const fixtures = loadFixtures(fixturesDir);
  const results = [];

  for (const fixture of fixtures) {
    const packet = await buildQuoteIntake({
      ...fixture.request,
      downloadAttachments: false
    });
    const analysis = analyzePacket(packet, fixture);
    const evaluation = evaluateAnalysis(fixture, analysis);
    results.push({ fixture, analysis, evaluation });
  }

  const passed = results.filter((result) => result.evaluation.ok).length;
  const failed = results.length - passed;

  console.log(`Quote Intake QA: ${passed}/${results.length} passed`);
  console.log('');

  for (const result of results) {
    const marker = result.evaluation.ok ? 'PASS' : 'FAIL';
    console.log(`${marker} ${result.fixture.id}: ${result.fixture.name}`);
    console.log(`  category: ${result.analysis.category}`);
    console.log(`  workflow: ${result.analysis.workflow}`);
    console.log(`  questions: ${result.analysis.questions.join(', ') || 'none'}`);
    console.log(`  pricing: ${result.analysis.pricingDrivers.join(', ') || 'none'}`);
    if (!result.evaluation.ok) {
      result.evaluation.failures.forEach((failure) => {
        console.log(`  - ${failure}`);
      });
    }
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
