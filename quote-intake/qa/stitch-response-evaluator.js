const fs = require('fs');
const path = require('path');

function normalize(value) {
  return String(value || '').toLowerCase();
}

function visibleLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function responsePathFor(fixturesDir, fixture) {
  return path.join(fixturesDir, 'stitch-responses', `${fixture.id}.txt`);
}

function readResponse(fixturesDir, fixture) {
  const filePath = responsePathFor(fixturesDir, fixture);
  if (!fs.existsSync(filePath)) {
    return { filePath, text: '' };
  }
  return { filePath, text: fs.readFileSync(filePath, 'utf8') };
}

function evaluateResponse(fixture, responseText) {
  const failures = [];
  const expected = fixture.expected || {};
  const text = normalize(responseText);
  const lines = visibleLines(responseText);

  if (!responseText.trim()) {
    failures.push('missing Stitch response text');
    return { ok: false, failures };
  }

  if (!text.includes('recommended draft')) {
    failures.push('missing "Recommended draft" section');
  }
  if (!text.includes('form:')) {
    failures.push('missing form summary');
  }
  if (!text.includes('pricing:')) {
    failures.push('missing pricing summary');
  }

  if (expected.category && !text.includes(expected.category)) {
    failures.push(`missing expected category ${expected.category}`);
  }
  if (expected.workflow === 'revise-existing' && !/\brevise|revision|existing quote|qu-\d{3,}/.test(text)) {
    failures.push('revision case does not clearly say revise existing quote');
  }
  if (expected.workflow === 'new-draft' && !/\bdraft|new quote|new draft/.test(text)) {
    failures.push('new quote case does not clearly say draft/new quote');
  }
  if (expected.workflow === 'special-workflow' && !/\bspecial workflow|approval workflow|knit backing workflow/.test(text)) {
    failures.push('special workflow case does not clearly route away from generic quote creation');
  }
  if (expected.workflow === 'ask-classification' && !/\bcategory|confirm/.test(text)) {
    failures.push('ambiguous case does not ask for category confirmation');
  }

  const requiredQuestions = expected.requiredQuestions || [];
  requiredQuestions.forEach((question) => {
    if (!text.includes(normalize(question))) {
      failures.push(`missing required question phrase: ${question}`);
    }
  });

  Object.entries(expected.formFields || {}).forEach(([field, value]) => {
    if (!text.includes(normalize(field)) && !text.includes(normalize(String(value)))) {
      failures.push(`missing form field/value cue: ${field}=${value}`);
    }
  });

  (expected.pricingDrivers || []).forEach((driver) => {
    if (!text.includes(normalize(driver))) {
      failures.push(`missing pricing driver cue: ${driver}`);
    }
  });

  const forbiddenTerms = [
    'drafted in chris@',
    'sent to',
    'emailed',
    'xero quote created',
    'xero contact created',
    'quote created successfully',
    'done - existing quote',
    'client-facing version',
    'hi ',
    'thank you,'
  ].concat(expected.mustNotContain || []);

  const forbiddenSeen = forbiddenTerms.filter((term) => text.includes(normalize(term)));
  if (forbiddenSeen.length) {
    failures.push(`contains forbidden live/action/email wording: ${forbiddenSeen.join(', ')}`);
  }

  if (lines.length > (expected.maxDecisionCardLines || 8)) {
    failures.push(`too wordy: ${lines.length} visible lines`);
  }

  return {
    ok: failures.length === 0,
    failures
  };
}

module.exports = {
  evaluateResponse,
  readResponse,
  responsePathFor,
  visibleLines
};
