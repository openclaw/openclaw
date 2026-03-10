/**
 * Tests for workflow-loader.js
 * Covers: YAML parsing, JSON parsing, validation, cycle detection, defaults normalization
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { loadWorkflow, loadWorkflowFromFile, listWorkflows } from '../workflow-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');

// ── Helper ─────────────────────────────────────────────────────────────────

async function withTempDir(fn) {
  const dir = join(tmpdir(), `wf-test-${randomBytes(4).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── YAML fixture loading ───────────────────────────────────────────────────

test('loads simple-linear.yml correctly', async () => {
  const wf = await loadWorkflow('simple-linear', FIXTURES_DIR);
  assert.equal(wf.name, 'Simple Linear Pipeline');
  assert.equal(wf.steps.length, 3);
  assert.equal(wf.steps[0].id, 'step-a');
  assert.equal(wf.steps[1].id, 'step-b');
  assert.deepEqual(wf.steps[1].depends_on, ['step-a']);
  assert.equal(wf.steps[2].id, 'step-c');
  assert.deepEqual(wf.steps[2].depends_on, ['step-b']);
});

test('loads parallel-steps.yml and respects concurrency', async () => {
  const wf = await loadWorkflow('parallel-steps', FIXTURES_DIR);
  assert.equal(wf.concurrency, 2);
  assert.equal(wf.steps[2].depends_on.length, 2);
  assert.deepEqual(wf.steps[2].depends_on, ['step-a', 'step-b']);
});

test('loads optional-step.yml and marks step as optional', async () => {
  const wf = await loadWorkflow('optional-step', FIXTURES_DIR);
  const optionalStep = wf.steps.find(s => s.id === 'optional-report');
  assert.ok(optionalStep, 'optional-report step should exist');
  assert.equal(optionalStep.optional, true);
});

test('loads retry-workflow.yml with retry config', async () => {
  const wf = await loadWorkflow('retry-workflow', FIXTURES_DIR);
  const flaky = wf.steps.find(s => s.id === 'flaky-step');
  assert.equal(flaky.retry, 2);
  assert.equal(flaky.retry_delay, 1);
});

// ── Default normalization ──────────────────────────────────────────────────

test('normalizes missing optional fields to defaults', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'minimal.yml'), `
name: Minimal Workflow
steps:
  - id: only-step
    task: Do something
`);
    const wf = await loadWorkflow('minimal', dir);
    assert.equal(wf.version, '1.0');
    assert.equal(wf.description, '');
    assert.equal(wf.concurrency, 3);
    const step = wf.steps[0];
    assert.deepEqual(step.depends_on, []);
    assert.deepEqual(step.outputs, []);
    assert.equal(step.model, null);
    assert.equal(step.timeout, 300);
    assert.equal(step.retry, 0);
    assert.equal(step.retry_delay, 30);
    assert.equal(step.optional, false);
    assert.equal(step.name, 'only-step'); // falls back to id
  });
});

test('step name defaults to id when not provided', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'wf.yml'), `
name: Test
steps:
  - id: my-step
    task: Do it
`);
    const wf = await loadWorkflow('wf', dir);
    assert.equal(wf.steps[0].name, 'my-step');
  });
});

test('concurrency is capped at 10', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'wf.yml'), `
name: Test
concurrency: 999
steps:
  - id: step-1
    task: Do it
`);
    const wf = await loadWorkflow('wf', dir);
    assert.equal(wf.concurrency, 10);
  });
});

test('concurrency minimum is 1', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'wf.yml'), `
name: Test
concurrency: 0
steps:
  - id: step-1
    task: Do it
`);
    const wf = await loadWorkflow('wf', dir);
    assert.equal(wf.concurrency, 1);
  });
});

// ── JSON format ───────────────────────────────────────────────────────────

test('loads workflow from JSON format', async () => {
  await withTempDir(async (dir) => {
    const workflow = {
      name: 'JSON Workflow',
      version: '1.0',
      steps: [
        { id: 'step-1', task: 'Do step 1', name: 'Step 1' },
        { id: 'step-2', task: 'Do step 2', name: 'Step 2', depends_on: ['step-1'] },
      ],
    };
    await writeFile(join(dir, 'json-wf.json'), JSON.stringify(workflow, null, 2));
    const wf = await loadWorkflow('json-wf', dir);
    assert.equal(wf.name, 'JSON Workflow');
    assert.equal(wf.steps.length, 2);
  });
});

// ── Validation errors ─────────────────────────────────────────────────────

test('throws if workflow name is missing', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'bad.yml'), `
steps:
  - id: step-1
    task: Do it
`);
    await assert.rejects(
      () => loadWorkflow('bad', dir),
      /missing required field "name"/
    );
  });
});

test('throws if steps array is empty', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'empty.yml'), `
name: Empty Workflow
steps: []
`);
    await assert.rejects(
      () => loadWorkflow('empty', dir),
      /non-empty "steps" array/
    );
  });
});

test('throws if step is missing id', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'bad.yml'), `
name: Bad Workflow
steps:
  - task: No ID here
`);
    await assert.rejects(
      () => loadWorkflow('bad', dir),
      /invalid or missing "id"/
    );
  });
});

test('throws on duplicate step IDs', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'dup.yml'), `
name: Dup IDs
steps:
  - id: step-1
    task: First
  - id: step-1
    task: Duplicate
`);
    await assert.rejects(
      () => loadWorkflow('dup', dir),
      /Duplicate step ID/
    );
  });
});

test('throws on unknown dependency reference', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'bad-dep.yml'), `
name: Bad Dep
steps:
  - id: step-a
    task: Do A
  - id: step-b
    task: Do B
    depends_on: [nonexistent-step]
`);
    await assert.rejects(
      () => loadWorkflow('bad-dep', dir),
      /unknown step ID "nonexistent-step"/
    );
  });
});

test('throws on circular dependency A → B → A', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'cycle.yml'), `
name: Circular
steps:
  - id: step-a
    task: Do A
    depends_on: [step-b]
  - id: step-b
    task: Do B
    depends_on: [step-a]
`);
    await assert.rejects(
      () => loadWorkflow('cycle', dir),
      /Circular dependency/
    );
  });
});

test('throws on three-step cycle A → B → C → A', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'cycle3.yml'), `
name: Three Cycle
steps:
  - id: a
    task: A
    depends_on: [c]
  - id: b
    task: B
    depends_on: [a]
  - id: c
    task: C
    depends_on: [b]
`);
    await assert.rejects(
      () => loadWorkflow('cycle3', dir),
      /Circular dependency/
    );
  });
});

test('throws if step is missing task', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'notask.yml'), `
name: No Task
steps:
  - id: step-1
    name: Step without task
`);
    await assert.rejects(
      () => loadWorkflow('notask', dir),
      /missing required field "task"/
    );
  });
});

test('throws if workflow file not found', async () => {
  await assert.rejects(
    () => loadWorkflow('does-not-exist', FIXTURES_DIR),
    /not found/
  );
});

// ── YAML extension variants ────────────────────────────────────────────────

test('loads .yaml extension', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'wf.yaml'), `
name: YAML Extension
steps:
  - id: step-1
    task: Do it
`);
    const wf = await loadWorkflow('wf', dir);
    assert.equal(wf.name, 'YAML Extension');
  });
});

// ── listWorkflows ──────────────────────────────────────────────────────────

test('listWorkflows returns entries sorted by name', async () => {
  const list = await listWorkflows(FIXTURES_DIR);
  assert.ok(list.length >= 5, `Expected at least 5 fixtures, got ${list.length}`);
  // Verify sorted
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i - 1].name <= list[i].name, 'Should be sorted alphabetically');
  }
});

test('listWorkflows returns empty array for empty dir', async () => {
  await withTempDir(async (dir) => {
    const list = await listWorkflows(dir);
    assert.deepEqual(list, []);
  });
});

test('listWorkflows includes display name from workflow file', async () => {
  const list = await listWorkflows(FIXTURES_DIR);
  const linear = list.find(w => w.name === 'simple-linear');
  assert.ok(linear, 'simple-linear should be in the list');
  assert.equal(linear.displayName, 'Simple Linear Pipeline');
});
