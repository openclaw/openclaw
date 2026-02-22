import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CODES = require('../reason-codes.cjs');
const { TAXONOMY, mapReasonCode } = require('../error-taxonomy.cjs');

test('all reason codes are covered by taxonomy', () => {
  const reasonCodes = Object.values(CODES);
  for (const code of reasonCodes) {
    assert.ok(TAXONOMY[code], `missing taxonomy mapping for ${code}`);
    assert.equal(typeof TAXONOMY[code].httpStatus, 'number');
    assert.ok(['policy', 'request', 'limits'].includes(TAXONOMY[code].class), `unexpected class "${TAXONOMY[code].class}" for ${code}`);
  }
});

test('unknown reason code maps to safe default', () => {
  const mapped = mapReasonCode('SOMETHING_ELSE');
  assert.deepEqual(mapped, { class: 'unknown', severity: 'error', httpStatus: 500 });
});
