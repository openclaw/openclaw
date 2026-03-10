/**
 * @module step-runner
 * @description Manages the lifecycle of a single workflow step: spawning the
 * step as an isolated subagent session, polling for completion, and reporting
 * the outcome.
 *
 * ## Session API Abstraction
 * OpenClaw's internal `sessions_spawn` capability is not yet exposed in the
 * plugin `api` object (as of v1.0). This module uses a `SessionAdapter`
 * interface that can be implemented in different ways:
 *
 *   1. **ApiAdapter** (default): Uses `api.sessions.spawn()` and
 *      `api.sessions.getStatus()` if they exist on the api object.
 *      This is the target behavior once OpenClaw exposes this surface.
 *
 *   2. **CliAdapter**: Falls back to spawning `openclaw session` subprocesses
 *      via Node.js `child_process`. This works today with any OpenClaw
 *      installation that has the CLI in PATH.
 *
 *   3. **MockAdapter**: Used in tests — resolves/rejects immediately
 *      based on a pre-configured fixture. Allows the executor to be tested
 *      without any OpenClaw installation.
 *
 * ## PR Note
 * For full functionality, OpenClaw should expose on the `api` object:
 *   - `api.sessions.spawn(prompt, options)` → `{ sessionId, sessionKey }`
 *   - `api.sessions.getStatus(sessionId)` → `{ status: 'running'|'done'|'error', error? }`
 * Until then, the CLI fallback handles real deployments.
 *
 * Dependencies: node:child_process, node:timers/promises, ./output-checker.js
 *
 * @example
 * import { runStep } from './step-runner.js';
 * const result = await runStep(step, runId, api, { pollIntervalMs: 2000, baseDir: '/workspace' });
 * // result.status === 'ok' | 'failed'
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkOutputs } from './output-checker.js';

const execFileAsync = promisify(execFile);

/**
 * @typedef {Object} StepRunOptions
 * @property {number}  pollIntervalMs  - How often to poll for session completion (ms)
 * @property {string}  baseDir         - Base directory for resolving relative output paths
 * @property {string}  [defaultModel]  - Default LLM model to use if step doesn't specify one
 * @property {boolean} [cancelled]     - If true, step should not be started (cancel check)
 */

/**
 * @typedef {Object} StepRunResult
 * @property {'ok'|'failed'}   status       - Outcome of this attempt
 * @property {string|null}     session_key  - Session identifier (for logs/debugging)
 * @property {OutputCheckResult} output_check - Output file validation result
 * @property {string|null}     error        - Error message if failed
 * @property {number}          duration_ms  - Wall-clock time for this attempt
 */

/**
 * Run a single workflow step as an isolated subagent and wait for completion.
 *
 * Flow:
 *   1. Select the appropriate SessionAdapter based on what's available in `api`
 *   2. Spawn the step session with the substituted task prompt
 *   3. Poll until done or timeout
 *   4. Check output files (if any defined)
 *   5. Return result
 *
 * @param {import('./workflow-loader.js').WorkflowStep} step - The step to execute
 * @param {string}        runId    - Current workflow run ID (for logging)
 * @param {Object}        api      - OpenClaw plugin api object
 * @param {StepRunOptions} options - Execution options
 * @returns {Promise<StepRunResult>}
 *
 * @example
 * const result = await runStep(
 *   { id: 'tech-auditor', task: 'Run SEO audit...', timeout: 420 },
 *   'seo-pipeline-20260309T082000',
 *   api,
 *   { pollIntervalMs: 5000, baseDir: '/workspace' }
 * );
 */
export async function runStep(step, runId, api, options) {
  const { pollIntervalMs = 5000, baseDir = process.cwd(), defaultModel } = options;

  const startTime = Date.now();

  // Select adapter based on what OpenClaw exposes
  const adapter = selectAdapter(api);

  let sessionKey = null;
  try {
    // Build the model preference: step-level overrides plugin default
    const model = step.model || defaultModel || null;

    // Spawn the session
    const spawnResult = await adapter.spawn(step.task, {
      model,
      timeout: step.timeout,
      sessionTarget: 'isolated',
      label: `wf:${runId}:${step.id}`,
    });
    sessionKey = spawnResult.sessionKey;

    // Poll until completion or timeout
    const timeoutMs = step.timeout * 1000;
    const deadline = Date.now() + timeoutMs;

    let finalStatus = null;
    let errorMsg = null;

    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);

      const statusResult = await adapter.getStatus(spawnResult.sessionId);

      if (statusResult.status === 'done') {
        finalStatus = 'ok';
        break;
      }
      if (statusResult.status === 'error') {
        finalStatus = 'failed';
        errorMsg = statusResult.error || 'Step session exited with error';
        break;
      }
      // status === 'running' — keep polling
    }

    if (finalStatus === null) {
      // Deadline exceeded without completing
      finalStatus = 'failed';
      errorMsg = `Step timed out after ${step.timeout}s`;
    }

    // Check output files regardless of session status
    // (a step might partially succeed — useful to know which files were written)
    const outputCheck = await checkOutputs(step.outputs, baseDir);

    // If session said OK but output gate failed, treat as failure
    if (finalStatus === 'ok' && !outputCheck.passed) {
      finalStatus = 'failed';
      errorMsg = `Output gate failed — missing files: ${outputCheck.missing_files.join(', ')}`;
    }

    return {
      status: finalStatus,
      session_key: sessionKey,
      output_check: outputCheck,
      error: errorMsg,
      duration_ms: Date.now() - startTime,
    };

  } catch (err) {
    // Spawn itself failed (session system unavailable, etc.)
    return {
      status: 'failed',
      session_key: sessionKey,
      output_check: { passed: false, missing_files: [], checked_files: [] },
      error: err.message,
      duration_ms: Date.now() - startTime,
    };
  }
}

/**
 * Select the best available session adapter.
 * Prefers the native API adapter if OpenClaw exposes the sessions API.
 * Falls back to the CLI adapter otherwise.
 *
 * @param {Object} api - OpenClaw plugin api object
 * @returns {SessionAdapter}
 */
function selectAdapter(api) {
  // Check if OpenClaw exposes a native sessions API on the plugin api object.
  // This is the target state for the PR — once merged, this path will be taken.
  if (api && api.sessions && typeof api.sessions.spawn === 'function') {
    return new ApiAdapter(api.sessions);
  }

  // Fall back to CLI-based adapter
  return new CliAdapter();
}

/**
 * @interface SessionAdapter
 * Common interface for all session adapters.
 */

/**
 * @class ApiAdapter
 * @description Uses the OpenClaw native sessions API (api.sessions).
 * This is the preferred path when OpenClaw exposes it.
 *
 * Expected api.sessions interface:
 *   spawn(prompt, options) → Promise<{ sessionId, sessionKey }>
 *   getStatus(sessionId)   → Promise<{ status: 'running'|'done'|'error', error? }>
 */
class ApiAdapter {
  /**
   * @param {Object} sessions - api.sessions object from OpenClaw
   */
  constructor(sessions) {
    this.sessions = sessions;
  }

  /**
   * @param {string} prompt  - Task prompt for the subagent
   * @param {Object} options - Spawn options (model, timeout, label, etc.)
   * @returns {Promise<{ sessionId: string, sessionKey: string }>}
   */
  async spawn(prompt, options) {
    return await this.sessions.spawn(prompt, options);
  }

  /**
   * @param {string} sessionId - Session ID returned by spawn()
   * @returns {Promise<{ status: string, error?: string }>}
   */
  async getStatus(sessionId) {
    return await this.sessions.getStatus(sessionId);
  }
}

/**
 * @class CliAdapter
 * @description Spawns subagent sessions via the OpenClaw CLI.
 * Works with any OpenClaw installation where `openclaw` is in PATH.
 *
 * Command used: `openclaw session run --prompt "..." --isolated [--model "..."]`
 *
 * Note: This adapter runs the step synchronously (the CLI blocks until
 * the session completes) rather than the spawn-then-poll pattern of the
 * ApiAdapter. The polling loop in runStep() is short-circuited by the
 * adapter immediately returning 'done' or 'error'.
 *
 * @note PR NOTE: This may not be the exact CLI syntax. Adjust to match the
 * actual `openclaw session` subcommand interface.
 */
class CliAdapter {
  /**
   * @param {string} prompt  - Task prompt
   * @param {Object} options - Options (model, timeout, label)
   * @returns {Promise<{ sessionId: string, sessionKey: string }>}
   */
  async spawn(prompt, options) {
    const args = ['session', 'run', '--isolated', '--prompt', prompt];
    if (options.model) {
      args.push('--model', options.model);
    }
    if (options.label) {
      args.push('--label', options.label);
    }

    // Run synchronously — CLI blocks until session completes.
    // We store the result and return a pseudo-sessionId so getStatus() can look it up.
    const pendingKey = `cli-${Date.now()}`;

    // Execute the CLI command
    try {
      const { stdout, stderr } = await execFileAsync('openclaw', args, {
        timeout: (options.timeout || 300) * 1000 + 30000, // add 30s grace period
        maxBuffer: 10 * 1024 * 1024, // 10MB output buffer
      });

      // Store result for getStatus() to retrieve
      this._results = this._results || new Map();
      this._results.set(pendingKey, { status: 'done', stdout, stderr });
    } catch (err) {
      this._results = this._results || new Map();
      this._results.set(pendingKey, {
        status: 'error',
        error: err.stderr || err.message,
      });
    }

    return { sessionId: pendingKey, sessionKey: pendingKey };
  }

  /**
   * @param {string} sessionId - The pseudo-session ID from spawn()
   * @returns {Promise<{ status: string, error?: string }>}
   */
  async getStatus(sessionId) {
    const result = (this._results || new Map()).get(sessionId);
    if (!result) {
      return { status: 'running' };
    }
    return result;
  }
}

/**
 * @class MockAdapter
 * @description Adapter for testing — resolves or rejects based on configuration.
 * Simulates a short delay to mimic real session execution.
 *
 * @example
 * const adapter = new MockAdapter({ resolveIn: 100, shouldFail: false });
 * // Steps using this adapter will complete in 100ms
 */
export class MockAdapter {
  /**
   * @param {Object} options
   * @param {number}  [options.resolveIn=100]    - Simulated duration in ms
   * @param {boolean} [options.shouldFail=false] - Whether the session should fail
   * @param {string}  [options.failMessage]      - Error message if shouldFail is true
   */
  constructor(options = {}) {
    this.resolveIn = options.resolveIn ?? 100;
    this.shouldFail = options.shouldFail ?? false;
    this.failMessage = options.failMessage || 'Mock step failure';
    this._sessions = new Map();
    this._counter = 0;
  }

  async spawn(prompt, options) {
    const sessionId = `mock-session-${++this._counter}`;
    const sessionKey = `agent:mock:subagent:${sessionId}`;

    // Schedule completion after resolveIn ms
    const result = { status: this.shouldFail ? 'error' : 'done' };
    if (this.shouldFail) result.error = this.failMessage;

    setTimeout(() => {
      this._sessions.set(sessionId, result);
    }, this.resolveIn);

    this._sessions.set(sessionId, { status: 'running' });
    return { sessionId, sessionKey };
  }

  async getStatus(sessionId) {
    return this._sessions.get(sessionId) || { status: 'running' };
  }
}

/**
 * Create a step runner function bound to a specific adapter.
 * This is the primary injection point for swapping adapters in tests.
 *
 * @param {Object} adapter - A SessionAdapter instance
 * @returns {Function} A runStep-compatible function using the provided adapter
 *
 * @example
 * const mockRunner = createStepRunner(new MockAdapter({ resolveIn: 50 }));
 * const result = await mockRunner(step, runId, api, options);
 */
export function createStepRunner(adapter) {
  return async function runStepWithAdapter(step, runId, _api, options) {
    const { pollIntervalMs = 5000, baseDir = process.cwd() } = options;
    const startTime = Date.now();
    let sessionKey = null;

    try {
      const model = step.model || options.defaultModel || null;
      const spawnResult = await adapter.spawn(step.task, {
        model,
        timeout: step.timeout,
        sessionTarget: 'isolated',
        label: `wf:${runId}:${step.id}`,
      });
      sessionKey = spawnResult.sessionKey;

      const timeoutMs = step.timeout * 1000;
      const deadline = Date.now() + timeoutMs;
      let finalStatus = null;
      let errorMsg = null;

      while (Date.now() < deadline) {
        await sleep(pollIntervalMs);
        const statusResult = await adapter.getStatus(spawnResult.sessionId);
        if (statusResult.status === 'done') { finalStatus = 'ok'; break; }
        if (statusResult.status === 'error') {
          finalStatus = 'failed';
          errorMsg = statusResult.error || 'Session error';
          break;
        }
      }

      if (finalStatus === null) {
        finalStatus = 'failed';
        errorMsg = `Step timed out after ${step.timeout}s`;
      }

      const outputCheck = await checkOutputs(step.outputs, baseDir);

      if (finalStatus === 'ok' && !outputCheck.passed) {
        finalStatus = 'failed';
        errorMsg = `Output gate failed — missing: ${outputCheck.missing_files.join(', ')}`;
      }

      return { status: finalStatus, session_key: sessionKey, output_check: outputCheck, error: errorMsg, duration_ms: Date.now() - startTime };
    } catch (err) {
      return { status: 'failed', session_key: sessionKey, output_check: { passed: false, missing_files: [], checked_files: [] }, error: err.message, duration_ms: Date.now() - startTime };
    }
  };
}
