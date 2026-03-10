/**
 * @module workflow-state
 * @description Manages reading and writing workflow run state files.
 *
 * Each workflow run is represented as a single JSON file at:
 *   {runsDir}/{run_id}.json
 *
 * State files are the source of truth for:
 *   - What steps are pending/running/complete
 *   - When each step started and finished
 *   - Which steps need retry
 *   - Overall pipeline status
 *
 * Design decisions:
 *   - Atomic writes via write-then-rename (using a temp file) to prevent
 *     corrupt state if the process crashes mid-write. On Linux, rename() is
 *     atomic for files on the same filesystem, so a crash leaves either the
 *     old or new state, never a partial write.
 *   - All timestamps are stored as ISO 8601 strings (UTC) for portability.
 *   - The run_id is embedded in the file content (not just the filename) so
 *     a state file is self-describing if moved or renamed.
 *
 * Dependencies: node:fs/promises, node:path, node:os
 *
 * @example
 * import { createRunState, updateRunState, readRunState, listRuns } from './workflow-state.js';
 *
 * const state = createRunState('seo-pipeline', steps, 'seo-pipeline-20260309T082000');
 * await saveRunState(state, '/home/user/.openclaw/workflow-runs');
 * const loaded = await readRunState('seo-pipeline-20260309T082000', '/home/user/.openclaw/workflow-runs');
 */

import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

/**
 * @typedef {'pending'|'running'|'ok'|'failed'|'cancelled'} RunStatus
 * @typedef {'pending'|'running'|'ok'|'failed'|'skipped'} StepStatus
 */

/**
 * @typedef {Object} StepState
 * @property {StepStatus}           status       - Current execution status
 * @property {string|null}          started_at   - ISO timestamp when step started
 * @property {string|null}          completed_at - ISO timestamp when step completed
 * @property {number|null}          duration_ms  - Wall-clock duration in milliseconds
 * @property {string|null}          session_key  - OpenClaw session identifier for this step
 * @property {OutputCheckResult|null} output_check - Result of output file validation
 * @property {string|null}          error        - Error message if step failed
 * @property {number}               attempts     - Number of execution attempts made so far
 */

/**
 * @typedef {Object} RunState
 * @property {string}                    run_id       - Unique run identifier
 * @property {string}                    workflow     - Workflow name (file stem)
 * @property {RunStatus}                 status       - Overall pipeline status
 * @property {string}                    started_at   - ISO timestamp when run started
 * @property {string|null}               completed_at - ISO timestamp when run finished
 * @property {Object.<string, StepState>} steps       - Per-step state keyed by step ID
 */

/**
 * Generate a unique run ID from a workflow name and current timestamp.
 * Format: {workflow-name}-{YYYYMMDDTHHmmss}
 * Colons are removed to make the ID safe for use as a filename.
 *
 * @param {string} workflowName - The workflow's name field
 * @returns {string} A unique, filesystem-safe run ID
 *
 * @example
 * generateRunId('seo-pipeline');
 * // → 'seo-pipeline-20260309T082000'
 */
export function generateRunId(workflowName) {
  // Slugify: lowercase, spaces/special chars → hyphens, trim hyphens
  const slug = workflowName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // UTC compact datetime: YYYYMMDDTHHmmss (no colons — safe for filenames)
  const now = new Date();
  const ts = now.toISOString()
    .replace(/[-:]/g, '')   // remove dashes and colons
    .replace(/\.\d+Z$/, ''); // remove milliseconds and Z → e.g. 20260309T082000

  return `${slug}-${ts}`;
}

/**
 * Create the initial (empty/pending) run state for a new workflow execution.
 * All steps start in 'pending' status. The run itself starts in 'pending'
 * and transitions to 'running' when the first step is launched.
 *
 * @param {string}   workflowName - Name of the workflow being run
 * @param {string[]} stepIds      - Ordered list of step IDs from the workflow definition
 * @param {string}   runId        - Pre-generated run ID
 * @returns {RunState}
 *
 * @example
 * const state = createRunState('seo-pipeline', ['tech-auditor', 'content-creator', 'standup'], 'seo-pipeline-20260309T082000');
 */
export function createRunState(workflowName, stepIds, runId) {
  /** @type {Object.<string, StepState>} */
  const steps = {};
  for (const id of stepIds) {
    steps[id] = {
      status: 'pending',
      started_at: null,
      completed_at: null,
      duration_ms: null,
      session_key: null,
      output_check: null,
      error: null,
      attempts: 0,
    };
  }

  return {
    run_id: runId,
    workflow: workflowName,
    status: 'pending',
    started_at: new Date().toISOString(),
    completed_at: null,
    steps,
  };
}

/**
 * Persist a run state object to disk.
 * Uses an atomic write pattern (write to temp file, then rename) to prevent
 * partial writes from corrupting the state file.
 *
 * @param {RunState} state   - The run state to save
 * @param {string}   runsDir - Directory where run files are stored
 * @returns {Promise<string>} The full path to the saved state file
 *
 * @example
 * await saveRunState(state, '/home/user/.openclaw/workflow-runs');
 */
export async function saveRunState(state, runsDir) {
  // Ensure the directory exists (creates recursively if needed)
  await mkdir(runsDir, { recursive: true });

  const targetPath = join(runsDir, `${state.run_id}.json`);
  const tempPath = join(tmpdir(), `wf-state-${randomBytes(6).toString('hex')}.json`);

  const json = JSON.stringify(state, null, 2);
  await writeFile(tempPath, json, 'utf8');

  // Atomic rename: on same-filesystem moves this is atomic.
  // On cross-filesystem moves (e.g. /tmp on a ramdisk), it copies then unlinks.
  // Either way, the target is never left in a partial state.
  try {
    await rename(tempPath, targetPath);
  } catch (err) {
    // rename() can fail cross-filesystem on some systems; fall back to direct write
    await writeFile(targetPath, json, 'utf8');
  }

  return targetPath;
}

/**
 * Read an existing run state file from disk.
 *
 * @param {string} runId    - The run ID to load
 * @param {string} runsDir  - Directory where run files are stored
 * @returns {Promise<RunState>} The parsed run state
 * @throws {Error} If the file does not exist or cannot be parsed
 *
 * @example
 * const state = await readRunState('seo-pipeline-20260309T082000', runsDir);
 */
export async function readRunState(runId, runsDir) {
  const filePath = join(runsDir, `${runId}.json`);
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Update a run state object immutably (returns new object) and save it.
 * Uses Object.assign for a shallow merge at the top level.
 * For step updates, merges the step's state with the provided updates.
 *
 * This is the primary mutation API — all state changes go through here
 * to ensure the state is always written to disk after modification.
 *
 * @param {RunState} state      - Current run state
 * @param {Partial<RunState>} updates - Top-level fields to update
 * @param {string} runsDir      - Directory where run files are stored
 * @returns {Promise<RunState>} The updated (new) run state after saving
 *
 * @example
 * state = await updateRunState(state, { status: 'running' }, runsDir);
 */
export async function updateRunState(state, updates, runsDir) {
  const newState = { ...state, ...updates };
  await saveRunState(newState, runsDir);
  return newState;
}

/**
 * Update the state of a single step within a run and persist to disk.
 *
 * @param {RunState}           state     - Current run state
 * @param {string}             stepId    - The step ID to update
 * @param {Partial<StepState>} stepUpdates - Fields to merge into the step state
 * @param {string}             runsDir   - Directory where run files are stored
 * @returns {Promise<RunState>} Updated run state
 *
 * @example
 * state = await updateStepState(state, 'tech-auditor', {
 *   status: 'running',
 *   started_at: new Date().toISOString(),
 *   attempts: 1,
 * }, runsDir);
 */
export async function updateStepState(state, stepId, stepUpdates, runsDir) {
  const newState = {
    ...state,
    steps: {
      ...state.steps,
      [stepId]: {
        ...state.steps[stepId],
        ...stepUpdates,
      },
    },
  };
  await saveRunState(newState, runsDir);
  return newState;
}

/**
 * List all run state files in the runs directory, sorted by start time (newest first).
 * Skips files that cannot be parsed (corrupted or non-JSON files).
 *
 * @param {string}  runsDir                - Directory to scan
 * @param {string}  [filterWorkflow]       - Optional: only return runs for this workflow name
 * @returns {Promise<RunState[]>} Array of run states, newest first
 *
 * @example
 * const runs = await listRuns(runsDir, 'seo-pipeline');
 * // [{ run_id: '...', status: 'ok', ... }, ...]
 */
export async function listRuns(runsDir, filterWorkflow = null) {
  try {
    await mkdir(runsDir, { recursive: true });
    const entries = await readdir(runsDir);
    const runs = [];

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(runsDir, entry), 'utf8');
        const state = JSON.parse(raw);
        if (filterWorkflow && state.workflow !== filterWorkflow) continue;
        runs.push(state);
      } catch {
        // Corrupted or non-run file — skip silently
      }
    }

    // Sort newest first by started_at
    runs.sort((a, b) => {
      const ta = a.started_at ? new Date(a.started_at).getTime() : 0;
      const tb = b.started_at ? new Date(b.started_at).getTime() : 0;
      return tb - ta;
    });

    return runs;
  } catch {
    // Directory doesn't exist yet — no runs
    return [];
  }
}

/**
 * Find the most recent run for a named workflow.
 *
 * @param {string} workflowName - Workflow name to search for
 * @param {string} runsDir      - Directory to scan
 * @returns {Promise<RunState|null>} Most recent run, or null if none exists
 */
export async function findLatestRun(workflowName, runsDir) {
  const runs = await listRuns(runsDir, workflowName);
  return runs.length > 0 ? runs[0] : null;
}
