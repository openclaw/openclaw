import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  loadPolicy,
  evaluateRequest,
  applySuccessToState,
} = require('../policy-engine.cjs');
const CODES = require('../reason-codes.cjs');

function mkPolicy({ dailyEnabled = true } = {}) {
  return {
    version: '1',
    mode: 'enforce',
    allowedChains: ['eip155:8453'],
    assets: {
      'eip155:8453': {
        USDC: {
          maxPerTx: '10',
          dailyCap: {
            enabled: dailyEnabled,
            amount: '20',
            timezone: 'UTC',
          },
        },
      },
    },
    recipientPolicy: {
      mode: 'allowlist',
      allow: ['0x1111111111111111111111111111111111111111'],
    },
    rateLimits: {
      minIntervalSeconds: 10,
    },
    actions: { allowTransfers: true },
  };
}

const request = {
  to: '0x1111111111111111111111111111111111111111',
  amount: '5',
  asset: 'USDC',
  chain: 'eip155:8453',
};

test('missing policy is fail-closed', () => {
  const res = loadPolicy('/tmp/definitely-not-here.json');
  assert.equal(res.ok, false);
  assert.equal(res.decision.reason, CODES.POLICY_MISSING);
});

test('invalid policy JSON is fail-closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402pol-'));
  const p = path.join(dir, 'policy.json');
  fs.writeFileSync(p, '{ nope');
  const res = loadPolicy(p);
  assert.equal(res.ok, false);
  assert.equal(res.decision.reason, CODES.POLICY_INVALID);
});

test('allowed request passes', () => {
  const decision = evaluateRequest({ policy: mkPolicy(), request, state: {}, now: new Date('2026-02-21T10:00:00Z') });
  assert.equal(decision.allow, true);
});

test('per-tx cap enforced', () => {
  const decision = evaluateRequest({
    policy: mkPolicy(),
    request: { ...request, amount: '11' },
    state: {},
    now: new Date('2026-02-21T10:00:00Z'),
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, CODES.PER_TX_EXCEEDED);
});

test('allowlist enforced', () => {
  const decision = evaluateRequest({
    policy: mkPolicy(),
    request: { ...request, to: '0x2222222222222222222222222222222222222222' },
    state: {},
    now: new Date('2026-02-21T10:00:00Z'),
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, CODES.RECIPIENT_DENIED);
});

test('daily cap enforced when enabled', () => {
  const policy = mkPolicy({ dailyEnabled: true });
  let state = { dailySpend: { 'eip155:8453:USDC:2026-02-21': 18 } };
  const decision = evaluateRequest({ policy, request, state, now: new Date('2026-02-21T12:00:00Z') });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, CODES.DAILY_CAP_EXCEEDED);

  // below cap should pass then increment
  state = { dailySpend: { 'eip155:8453:USDC:2026-02-21': 10 } };
  const ok = evaluateRequest({ policy, request, state, now: new Date('2026-02-21T12:00:00Z') });
  assert.equal(ok.allow, true);
  const next = applySuccessToState({ policy, request, state, now: new Date('2026-02-21T12:00:00Z') });
  assert.equal(next.dailySpend['eip155:8453:USDC:2026-02-21'], 15);
});

test('daily cap not evaluated when disabled', () => {
  const policy = mkPolicy({ dailyEnabled: false });
  const state = { dailySpend: { 'eip155:8453:USDC:2026-02-21': 1000 } };
  const decision = evaluateRequest({ policy, request, state, now: new Date('2026-02-21T12:00:00Z') });
  assert.equal(decision.allow, true);
});
