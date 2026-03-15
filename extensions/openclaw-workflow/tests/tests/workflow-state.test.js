/**
 * Tests for workflow-state.js
 * Covers: state creation, save/load, updateRunState, updateStepState, listRuns, findLatestRun
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  generateRunId,
  createRunState,
  saveRunState,
  readRunState,
  updateRunState,
  updateStepState,
  listRuns,
  findLatestRun,
} from '../workflow-state.js';

// ── Helper ─────────────────────────────────────────────────────────────────

async function withTempDir(fn) {
  const dir = join(tmpdir(), `wf-state-test-${randomBytes(4).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── generateRunId ──────────────────────────────────────────────────────────

test('generateRunId produces filesystem-safe IDs', () => {
  const id = generateRunId('SEO Pipeline!');
  // Should be slugified and contain a timestamp
  // Note: the ISO timestamp separator 'T' may be uppercase (e.g. 20260309T082000)
  assert.ok(/^[a-z0-9T-]+$/.test(id), `ID should be lowercase alphanumeric+hyphen+T: ${id}`);
  assert.ok(id.includes('-'), 'Should contain hyphens');
  // Should not contain special chars (other than alphanumeric, hyphen, uppercase T)
  assert.ok(!/[!@#$%^&*()+=\[\]{};':"\\|,.<>\/?\s]/.test(id));
});

test('generateRunId slugifies workflow name', () => {
  const id = generateRunId('My Awesome Workflow');
  assert.ok(id.startsWith('my-awesome-workflow-'), `Expected my-awesome-workflow- prefix, got: ${id}`);
});

test('generateRunId removes special characters', () => {
  const id = generateRunId('SEO: Daily (v2)');
  assert.ok(/^[a-z0-9-]+-\d{8}T\d{6}$/.test(id), `ID format mismatch: ${id}`);
});

test('generateRunId two calls are different (different timestamps)', async () => {
  const id1 = generateRunId('test');
  await new Promise(r => setTimeout(r, 1100)); // Wait > 1 second
  const id2 = generateRunId('test');
  assert.notEqual(id1, id2, 'Two run IDs should differ due to timestamp');
});

// ── createRunState ─────────────────────────────────────────────────────────

test('createRunState creates pending state for all steps', () => {
  const state = createRunState('seo-pipeline', ['step-a', 'step-b', 'step-c'], 'test-run-id');
  assert.equal(state.run_id, 'test-run-id');
  assert.equal(state.workflow, 'seo-pipeline');
  assert.equal(state.status, 'pending');
  assert.ok(state.started_at, 'Should have a started_at timestamp');
  assert.equal(state.completed_at, null);
  assert.deepEqual(Object.keys(state.steps), ['step-a', 'step-b', 'step-c']);

  for (const stepId of ['step-a', 'step-b', 'step-c']) {
    const step = state.steps[stepId];
    assert.equal(step.status, 'pending');
    assert.equal(step.started_at, null);
    assert.equal(step.completed_at, null);
    assert.equal(step.duration_ms, null);
    assert.equal(step.session_key, null);
    assert.equal(step.output_check, null);
    assert.equal(step.error, null);
    assert.equal(step.attempts, 0);
  }
});

test('createRunState started_at is a valid ISO date', () => {
  const state = createRunState('wf', ['step-1'], 'run-1');
  const parsed = new Date(state.started_at);
  assert.ok(!isNaN(parsed.getTime()), 'started_at should be a valid date');
});

// ── saveRunState + readRunState ────────────────────────────────────────────

test('saves and reads back run state correctly', async () => {
  await withTempDir(async (dir) => {
    const state = createRunState('test-wf', ['step-1', 'step-2'], 'test-run-42');
    await saveRunState(state, dir);
    const loaded = await readRunState('test-run-42', dir);
    assert.deepEqual(loaded, state);
  });
});

test('readRunState throws ENOENT for non-existent run', async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => readRunState('does-not-exist', dir),
      (err) => err.code === 'ENOENT'
    );
  });
});

test('saveRunState creates directory if it does not exist', async () => {
  await withTempDir(async (dir) => {
    const nestedDir = join(dir, 'a', 'b', 'c');
    const state = createRunState('wf', ['step-1'], 'nested-run');
    // Should not throw even though dir doesn't exist
    await saveRunState(state, nestedDir);
    const loaded = await readRunState('nested-run', nestedDir);
    assert.equal(loaded.run_id, 'nested-run');
  });
});

// ── updateRunState ─────────────────────────────────────────────────────────

test('updateRunState returns new state and saves to disk', async () => {
  await withTempDir(async (dir) => {
    let state = createRunState('wf', ['step-1'], 'run-update-test');
    state = await updateRunState(state, { status: 'running' }, dir);

    assert.equal(state.status, 'running');

    // Verify persisted
    const diskState = await readRunState('run-update-test', dir);
    assert.equal(diskState.status, 'running');
  });
});

test('updateRunState does not mutate original state object', async () => {
  await withTempDir(async (dir) => {
    const original = createRunState('wf', ['step-1'], 'immutable-test');
    const updated = await updateRunState(original, { status: 'running' }, dir);

    assert.equal(original.status, 'pending', 'Original should be unchanged');
    assert.equal(updated.status, 'running');
  });
});

// ── updateStepState ────────────────────────────────────────────────────────

test('updateStepState updates a single step and saves', async () => {
  await withTempDir(async (dir) => {
    let state = createRunState('wf', ['step-a', 'step-b'], 'step-update-test');
    state = await updateStepState(state, 'step-a', {
      status: 'running',
      started_at: '2026-03-09T08:00:00.000Z',
      attempts: 1,
    }, dir);

    assert.equal(state.steps['step-a'].status, 'running');
    assert.equal(state.steps['step-a'].attempts, 1);
    // step-b should be unchanged
    assert.equal(state.steps['step-b'].status, 'pending');

    const diskState = await readRunState('step-update-test', dir);
    assert.equal(diskState.steps['step-a'].status, 'running');
  });
});

test('updateStepState merges — does not replace entire step', async () => {
  await withTempDir(async (dir) => {
    let state = createRunState('wf', ['step-1'], 'merge-test');
    // First update — set started_at
    state = await updateStepState(state, 'step-1', {
      status: 'running',
      started_at: 'T1',
      attempts: 1,
    }, dir);
    // Second update — set completed_at without touching started_at
    state = await updateStepState(state, 'step-1', {
      status: 'ok',
      completed_at: 'T2',
      duration_ms: 5000,
    }, dir);

    const s = state.steps['step-1'];
    assert.equal(s.status, 'ok');
    assert.equal(s.started_at, 'T1', 'started_at should be preserved from first update');
    assert.equal(s.completed_at, 'T2');
    assert.equal(s.attempts, 1, 'attempts should be preserved');
  });
});

// ── listRuns ───────────────────────────────────────────────────────────────

test('listRuns returns empty array when directory is empty', async () => {
  await withTempDir(async (dir) => {
    const runs = await listRuns(dir);
    assert.deepEqual(runs, []);
  });
});

test('listRuns returns all runs sorted newest first', async () => {
  await withTempDir(async (dir) => {
    // Create runs with different started_at
    const s1 = createRunState('wf', ['step-1'], 'run-1');
    s1.started_at = '2026-03-09T08:00:00.000Z';
    const s2 = createRunState('wf', ['step-1'], 'run-2');
    s2.started_at = '2026-03-09T10:00:00.000Z';
    const s3 = createRunState('wf', ['step-1'], 'run-3');
    s3.started_at = '2026-03-09T09:00:00.000Z';

    await saveRunState(s1, dir);
    await saveRunState(s2, dir);
    await saveRunState(s3, dir);

    const runs = await listRuns(dir);
    assert.equal(runs.length, 3);
    assert.equal(runs[0].run_id, 'run-2'); // newest
    assert.equal(runs[1].run_id, 'run-3');
    assert.equal(runs[2].run_id, 'run-1'); // oldest
  });
});

test('listRuns filters by workflow name', async () => {
  await withTempDir(async (dir) => {
    const s1 = createRunState('seo-pipeline', ['step-1'], 'seo-run-1');
    const s2 = createRunState('deploy-pipeline', ['step-1'], 'deploy-run-1');
    await saveRunState(s1, dir);
    await saveRunState(s2, dir);

    const seoRuns = await listRuns(dir, 'seo-pipeline');
    assert.equal(seoRuns.length, 1);
    assert.equal(seoRuns[0].run_id, 'seo-run-1');
  });
});

test('listRuns skips non-JSON files gracefully', async () => {
  await withTempDir(async (dir) => {
    const { writeFile } = await import('node:fs/promises');
    // Write a non-JSON file into the runs dir
    await writeFile(join(dir, 'not-a-run.txt'), 'not json');
    await writeFile(join(dir, 'corrupted.json'), '{ this is not valid json');

    const state = createRunState('wf', ['step-1'], 'valid-run');
    await saveRunState(state, dir);

    const runs = await listRuns(dir);
    assert.equal(runs.length, 1, 'Should only return valid state files');
  });
});

// ── findLatestRun ──────────────────────────────────────────────────────────

test('findLatestRun returns most recent run for workflow', async () => {
  await withTempDir(async (dir) => {
    const s1 = createRunState('my-wf', ['step-1'], 'my-wf-run-1');
    s1.started_at = '2026-03-09T08:00:00.000Z';
    const s2 = createRunState('my-wf', ['step-1'], 'my-wf-run-2');
    s2.started_at = '2026-03-09T12:00:00.000Z';

    await saveRunState(s1, dir);
    await saveRunState(s2, dir);

    const latest = await findLatestRun('my-wf', dir);
    assert.equal(latest.run_id, 'my-wf-run-2');
  });
});

test('findLatestRun returns null when no runs exist', async () => {
  await withTempDir(async (dir) => {
    const result = await findLatestRun('nonexistent-wf', dir);
    assert.equal(result, null);
  });
});
