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
 * Preamble injected at the start of every step task prompt.
 *
 * Addresses a known OpenClaw behavior: the exec tool backgrounds commands that
 * run longer than ~10 seconds (default yieldMs), returning "Command still running"
 * without any output. Without this instruction, an agent that runs a 15-30s bash
 * script will see no output and incorrectly conclude the step failed.
 *
 * The preamble instructs the agent to detect this condition and poll via the
 * process tool before interpreting any result.
 *
 * @constant {string}
 */
const EXEC_POLL_PREAMBLE = `\
IMPORTANT — exec tool behaviour:
1. For any command that may take longer than 10 seconds, always pass yieldMs=300000 \
to the exec tool. This prevents backgrounding and returns output inline.
2. If an exec call returns "Command still running (session <name>...)", the command \
was backgrounded. In that case you MUST immediately call \
process(action="poll", sessionId="<name>", timeout=60000) to retrieve the full \
output before proceeding.
3. Never interpret a backgrounded exec as a failure. Only report failure if the \
final exit code is non-zero or the output explicitly indicates an error.

`;

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

    // Wrap the task with exec-poll instructions so the agent handles backgrounded
    // bash commands correctly (commands taking >10s are backgrounded by the exec tool).
    const taskWithPreamble = EXEC_POLL_PREAMBLE + step.task;

    // Spawn the session
    const spawnResult = await adapter.spawn(taskWithPreamble, {
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
 * @description Spawns subagent sessions via the OpenClaw CLI using one-shot
 * cron jobs. Works with any OpenClaw installation where `openclaw` is in PATH.
 *
 * ## Approach
 * Since `openclaw sessions spawn` is not exposed as a CLI command, this adapter
 * uses the cron subsystem as a session-spawning mechanism:
 *   1. `openclaw cron add --at +5s --session isolated --message "..." --json`
 *      creates a one-shot job and returns its job ID.
 *   2. `openclaw cron run <id>` triggers it immediately.
 *   3. `openclaw cron runs --id <id> --json` polls for the run result.
 *   4. `openclaw cron remove <id>` cleans up after completion.
 *
 * The spawn() call returns immediately with the cron job ID as the sessionId.
 * getStatus() polls the cron run history to detect completion.
 *
 * ## Exec yieldMs note
 * Step task prompts are wrapped with exec-poll instructions (see EXEC_POLL_PREAMBLE)
 * so the spawned agent correctly handles bash commands that take >10s (the default
 * exec yieldMs) by polling via the process tool rather than seeing empty output.
 */
class CliAdapter {
  /**
   * @param {string} prompt  - Task prompt
   * @param {Object} options - Options (model, timeout, label)
   * @returns {Promise<{ sessionId: string, sessionKey: string }>}
   */
  async spawn(prompt, options) {
    this._jobs = this._jobs || new Map();

    // Build cron add args — one-shot job that runs immediately
    const args = [
      'cron', 'add',
      '--at', '+5s',
      '--session', 'isolated',
      '--message', prompt,
      '--delete-after-run',
      '--json',
    ];
    if (options.model) {
      args.push('--model', options.model);
    }
    if (options.label) {
      args.push('--name', options.label);
    }

    let jobId;
    try {
      const { stdout } = await execFileAsync('openclaw', args, {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      const parsed = JSON.parse(stdout.trim());
      // CLI returns { id: '...' } or { job: { id: '...' } }
      jobId = parsed.id || parsed.job?.id;
      if (!jobId) throw new Error(`Unexpected cron add output: ${stdout}`);
    } catch (err) {
      throw new Error(`CliAdapter: cron add failed — ${err.message}`);
    }

    // Trigger the job immediately (it was created with +5s, but run now)
    try {
      await execFileAsync('openclaw', ['cron', 'run', jobId], { timeout: 10000 });
    } catch (err) {
      // Non-fatal — the job may already be queued to run in 5s
    }

    this._jobs.set(jobId, { status: 'running' });
    return { sessionId: jobId, sessionKey: `cli-cron:${jobId}` };
  }

  /**
   * Poll the cron run history to check if the one-shot job has completed.
   *
   * @param {string} sessionId - The cron job ID returned by spawn()
   * @returns {Promise<{ status: string, error?: string }>}
   */
  async getStatus(sessionId) {
    const jobId = sessionId;
    try {
      const { stdout } = await execFileAsync(
        'openclaw',
        ['cron', 'runs', '--id', jobId, '--limit', '1', '--json'],
        { timeout: 15000 },
      );
      const lines = stdout.trim().split('\n').filter(Boolean);
      if (!lines.length) return { status: 'running' };

      // JSONL — take the last line
      const entry = JSON.parse(lines[lines.length - 1]);
      if (entry.action === 'finished') {
        // Clean up the cron job (best-effort — may already be deleted if --delete-after-run)
        execFileAsync('openclaw', ['cron', 'remove', jobId]).catch(() => {});
        return entry.status === 'ok'
          ? { status: 'done' }
          : { status: 'error', error: entry.error || entry.summary || 'Step failed' };
      }
      return { status: 'running' };
    } catch (err) {
      // If the job no longer exists (deleted after run), treat as done
      if (err.message.includes('not found') || err.message.includes('404')) {
        return { status: 'done' };
      }
      return { status: 'running' };
    }
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
      const taskWithPreamble = EXEC_POLL_PREAMBLE + step.task;
      const spawnResult = await adapter.spawn(taskWithPreamble, {
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
