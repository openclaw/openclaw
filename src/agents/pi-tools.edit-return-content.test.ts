import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHostWorkspaceEditTool } from './pi-tools.read.js';

describe('Edit tool returns current content on mismatch', () => {
  let tempDir: string;
  let testFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-tool-test-'));
    testFile = path.join(tempDir, 'test.txt');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should return current file content when oldText does not match', async () => {
    // Create test file
    const originalContent = 'Hello World\nLine 2\nLine 3';
    await fs.writeFile(testFile, originalContent);

    // Create edit tool
    const editTool = createHostWorkspaceEditTool(tempDir);

    // Try to edit with wrong oldText
    const result = await editTool.execute(
      'test-call-id',
      {
        file_path: testFile,
        oldText: 'Wrong text that does not exist',
        newText: 'Replacement text',
      },
      undefined
    );

    // Should be an error
    expect(result.isError).toBe(true);

    // Should include current file content
    const textContent = result.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    expect(textContent).toContain('Current file content');
    expect(textContent).toContain('Hello World');
    expect(textContent).toContain('Line 2');
    expect(textContent).toContain('Line 3');
  });

  it('should successfully edit when oldText matches', async () => {
    // Create test file
    const originalContent = 'Hello World\nLine 2\nLine 3';
    await fs.writeFile(testFile, originalContent);

    // Create edit tool
    const editTool = createHostWorkspaceEditTool(tempDir);

    // Edit with correct oldText
    const result = await editTool.execute(
      'test-call-id',
      {
        file_path: testFile,
        oldText: 'Hello World',
        newText: 'Hello OpenClaw',
      },
      undefined
    );

    // Should succeed
    expect(result.isError).toBeUndefined();

    // File should be updated
    const updatedContent = await fs.readFile(testFile, 'utf-8');
    expect(updatedContent).toBe('Hello OpenClaw\nLine 2\nLine 3');
  });

  it('should handle file not found gracefully', async () => {
    // Create edit tool
    const editTool = createHostWorkspaceEditTool(tempDir);

    // Try to edit non-existent file
    const result = await editTool.execute(
      'test-call-id',
      {
        file_path: path.join(tempDir, 'nonexistent.txt'),
        oldText: 'Some text',
        newText: 'New text',
      },
      undefined
    );

    // Should be an error
    expect(result.isError).toBe(true);

    // Should NOT include current content section (file doesn't exist)
    const textContent = result.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    expect(textContent).not.toContain('Current file content');
  });
});
