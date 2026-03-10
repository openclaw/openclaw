/**
 * Tests for variable-substitution.js
 * Covers: buildContext, substituteVars, substituteDeep
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildContext, substituteVars, substituteDeep } from '../variable-substitution.js';

// ── buildContext ───────────────────────────────────────────────────────────

test('buildContext returns correct date format', () => {
  const fixed = new Date('2026-03-09T14:22:00.000Z');
  const ctx = buildContext('my-run', fixed);
  assert.equal(ctx.date, '2026-03-09');
});

test('buildContext returns full ISO datetime', () => {
  const fixed = new Date('2026-03-09T14:22:00.000Z');
  const ctx = buildContext('my-run', fixed);
  assert.equal(ctx.datetime, '2026-03-09T14:22:00.000Z');
});

test('buildContext preserves run_id', () => {
  const ctx = buildContext('seo-pipeline-20260309T082000');
  assert.equal(ctx.run_id, 'seo-pipeline-20260309T082000');
});

test('buildContext uses current time when now not provided', () => {
  const before = new Date();
  const ctx = buildContext('test-run');
  const after = new Date();
  const ctxTime = new Date(ctx.datetime);
  assert.ok(ctxTime >= before);
  assert.ok(ctxTime <= after);
});

// ── substituteVars ─────────────────────────────────────────────────────────

test('substitutes {date}', () => {
  const ctx = buildContext('run', new Date('2026-03-09T08:00:00Z'));
  assert.equal(substituteVars('output-{date}.json', ctx), 'output-2026-03-09.json');
});

test('substitutes {datetime}', () => {
  const ctx = buildContext('run', new Date('2026-03-09T08:00:00.000Z'));
  assert.equal(
    substituteVars('Report at {datetime}', ctx),
    'Report at 2026-03-09T08:00:00.000Z'
  );
});

test('substitutes {run_id}', () => {
  const ctx = buildContext('my-run-abc');
  assert.equal(substituteVars('Run: {run_id}', ctx), 'Run: my-run-abc');
});

test('substitutes multiple variables in one string', () => {
  const ctx = buildContext('run-123', new Date('2026-03-09T10:00:00.000Z'));
  const result = substituteVars('{run_id} started on {date}', ctx);
  assert.equal(result, 'run-123 started on 2026-03-09');
});

test('leaves unknown variables unchanged', () => {
  const ctx = buildContext('run');
  assert.equal(substituteVars('Hello {name}', ctx), 'Hello {name}');
});

test('handles string with no variables', () => {
  const ctx = buildContext('run');
  assert.equal(substituteVars('No variables here', ctx), 'No variables here');
});

test('handles empty string', () => {
  const ctx = buildContext('run');
  assert.equal(substituteVars('', ctx), '');
});

test('returns non-string values unchanged', () => {
  const ctx = buildContext('run');
  assert.equal(substituteVars(42, ctx), 42);
  assert.equal(substituteVars(null, ctx), null);
  assert.equal(substituteVars(undefined, ctx), undefined);
  assert.equal(substituteVars(true, ctx), true);
});

test('substitutes same variable multiple times', () => {
  const ctx = buildContext('run', new Date('2026-03-09T00:00:00Z'));
  assert.equal(
    substituteVars('{date}/{date}/{date}', ctx),
    '2026-03-09/2026-03-09/2026-03-09'
  );
});

// ── substituteDeep ─────────────────────────────────────────────────────────

test('substituteDeep processes nested object', () => {
  const ctx = buildContext('run-x', new Date('2026-03-09T08:00:00Z'));
  const obj = {
    task: 'Run audit for {date}',
    outputs: ['data/{date}/output.json'],
    nested: { label: 'Run {run_id}' },
  };
  const result = substituteDeep(obj, ctx);
  assert.equal(result.task, 'Run audit for 2026-03-09');
  assert.equal(result.outputs[0], 'data/2026-03-09/output.json');
  assert.equal(result.nested.label, 'Run run-x');
});

test('substituteDeep processes arrays', () => {
  const ctx = buildContext('run', new Date('2026-03-09T00:00:00Z'));
  const arr = ['file-{date}-a.json', 'file-{date}-b.json'];
  const result = substituteDeep(arr, ctx);
  assert.deepEqual(result, ['file-2026-03-09-a.json', 'file-2026-03-09-b.json']);
});

test('substituteDeep leaves numbers untouched', () => {
  const ctx = buildContext('run');
  const obj = { timeout: 300, name: 'Run {run_id}' };
  const result = substituteDeep(obj, ctx);
  assert.equal(result.timeout, 300);
});

test('substituteDeep leaves booleans untouched', () => {
  const ctx = buildContext('run');
  const obj = { optional: true, name: '{run_id}' };
  const result = substituteDeep(obj, ctx);
  assert.equal(result.optional, true);
});

test('substituteDeep does not mutate input', () => {
  const ctx = buildContext('run');
  const original = { task: 'Hello {date}' };
  const result = substituteDeep(original, ctx);
  assert.equal(original.task, 'Hello {date}', 'Original should be unchanged');
  assert.notEqual(result.task, original.task);
});

test('substituteDeep handles null values', () => {
  const ctx = buildContext('run');
  const obj = { model: null, task: 'Hello {run_id}' };
  const result = substituteDeep(obj, ctx);
  assert.equal(result.model, null);
});
