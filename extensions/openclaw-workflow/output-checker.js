/**
 * @module output-checker
 * @description Validates that expected output files exist after a workflow step completes.
 *
 * Output gates serve as a contract: if a step claims to produce certain files,
 * we verify those files actually exist before marking the step as successful.
 * This prevents silent failures where a step appears to succeed but produced
 * no usable artifacts for downstream steps.
 *
 * Why file-based checks? Workflow steps are typically AI agents that write
 * files (reports, JSON handoffs, content drafts). Checking file existence is
 * a lightweight, universal signal of step completion that works without any
 * special instrumentation inside the step itself.
 *
 * Future extension points:
 *   - File size minimums (avoid empty-file false positives)
 *   - Content validation via JSON schema
 *   - Glob pattern support for dynamic file names
 *
 * Dependencies: node:fs/promises, node:path
 *
 * @example
 * import { checkOutputs } from './output-checker.js';
 * const result = await checkOutputs(
 *   ['data/seo-state/ta-handoff-2026-03-09.json'],
 *   '/home/user/project'
 * );
 * // result.passed === true  (if file exists)
 * // result.missing_files === []
 */

import { access } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';

/**
 * @typedef {Object} OutputCheckResult
 * @property {boolean}  passed        - True if all expected outputs exist
 * @property {string[]} missing_files - List of paths that were not found
 * @property {string[]} checked_files - Full resolved paths that were checked
 */

/**
 * Check that all expected output files exist on disk.
 * Paths that are already absolute are checked as-is. Relative paths are
 * resolved against `baseDir`. This allows workflows to use short relative
 * paths (e.g. `data/output.json`) without embedding absolute paths.
 *
 * @param {string[]} expectedPaths - List of file paths to check (may be relative)
 * @param {string}   baseDir       - Base directory for resolving relative paths
 * @returns {Promise<OutputCheckResult>}
 *
 * @example
 * // All exist:
 * await checkOutputs(['out/report.json'], '/workspace')
 * // → { passed: true, missing_files: [], checked_files: ['/workspace/out/report.json'] }
 *
 * // Some missing:
 * await checkOutputs(['out/missing.json'], '/workspace')
 * // → { passed: false, missing_files: ['/workspace/out/missing.json'], checked_files: [...] }
 */
export async function checkOutputs(expectedPaths, baseDir) {
  // If no outputs defined, the gate trivially passes — not every step needs
  // output files; some steps are purely side-effectful (e.g. sending notifications).
  if (!expectedPaths || expectedPaths.length === 0) {
    return { passed: true, missing_files: [], checked_files: [] };
  }

  const checked_files = [];
  const missing_files = [];

  for (const rawPath of expectedPaths) {
    // Resolve to absolute path
    const absPath = isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath);
    checked_files.push(absPath);

    try {
      // access() with no mode defaults to F_OK — just checks existence
      await access(absPath);
      // File exists — no action needed
    } catch {
      // File does not exist (or is inaccessible)
      missing_files.push(absPath);
    }
  }

  return {
    passed: missing_files.length === 0,
    missing_files,
    checked_files,
  };
}
