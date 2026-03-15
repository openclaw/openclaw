/**
 * Tests for output-checker.js
 * Covers: empty paths, existing files, missing files, absolute paths, relative paths
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { checkOutputs } from '../output-checker.js';

// ── Helper ─────────────────────────────────────────────────────────────────

async function withTempDir(fn) {
  const dir = join(tmpdir(), `output-check-${randomBytes(4).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── Empty / null paths ─────────────────────────────────────────────────────

test('passes trivially with empty path list', async () => {
  const result = await checkOutputs([], '/some/dir');
  assert.equal(result.passed, true);
  assert.deepEqual(result.missing_files, []);
  assert.deepEqual(result.checked_files, []);
});

test('passes trivially with null paths', async () => {
  const result = await checkOutputs(null, '/some/dir');
  assert.equal(result.passed, true);
});

test('passes trivially with undefined paths', async () => {
  const result = await checkOutputs(undefined, '/some/dir');
  assert.equal(result.passed, true);
});

// ── Existing files ─────────────────────────────────────────────────────────

test('passes when all files exist (relative paths)', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'output.json'), '{}');
    await writeFile(join(dir, 'report.md'), '# Report');

    const result = await checkOutputs(['output.json', 'report.md'], dir);
    assert.equal(result.passed, true);
    assert.deepEqual(result.missing_files, []);
    assert.equal(result.checked_files.length, 2);
  });
});

test('passes when all files exist (absolute paths)', async () => {
  await withTempDir(async (dir) => {
    const absPath = join(dir, 'absolute.json');
    await writeFile(absPath, '{}');

    // Absolute paths should not be joined with baseDir
    const result = await checkOutputs([absPath], '/completely/different/dir');
    assert.equal(result.passed, true);
    assert.deepEqual(result.missing_files, []);
  });
});

test('resolves relative paths against baseDir', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'data', 'seo'), { recursive: true });
    const filePath = join(dir, 'data', 'seo', 'handoff.json');
    await writeFile(filePath, '{}');

    const result = await checkOutputs(['data/seo/handoff.json'], dir);
    assert.equal(result.passed, true);
    // The checked_files list should contain the resolved absolute path
    assert.ok(result.checked_files[0].includes('handoff.json'));
  });
});

// ── Missing files ──────────────────────────────────────────────────────────

test('fails when a file is missing', async () => {
  await withTempDir(async (dir) => {
    const result = await checkOutputs(['missing-output.json'], dir);
    assert.equal(result.passed, false);
    assert.equal(result.missing_files.length, 1);
    assert.ok(result.missing_files[0].includes('missing-output.json'));
  });
});

test('fails when some files are missing (partial)', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'exists.json'), '{}');
    // 'missing.json' is not created

    const result = await checkOutputs(['exists.json', 'missing.json'], dir);
    assert.equal(result.passed, false);
    assert.equal(result.missing_files.length, 1);
    assert.ok(result.missing_files[0].includes('missing.json'));
    // checked_files includes both
    assert.equal(result.checked_files.length, 2);
  });
});

test('all missing files are reported (not just first)', async () => {
  await withTempDir(async (dir) => {
    const result = await checkOutputs(['a.json', 'b.json', 'c.json'], dir);
    assert.equal(result.passed, false);
    assert.equal(result.missing_files.length, 3);
  });
});

// ── Mixed absolute + relative ──────────────────────────────────────────────

test('handles mix of absolute and relative paths', async () => {
  await withTempDir(async (dir) => {
    const absFile = join(dir, 'absolute.json');
    await writeFile(absFile, '{}');
    await writeFile(join(dir, 'relative.json'), '{}');

    const result = await checkOutputs([absFile, 'relative.json'], dir);
    assert.equal(result.passed, true);
  });
});
