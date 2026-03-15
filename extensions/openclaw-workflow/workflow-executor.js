/**
 * @module workflow-executor
 * @description The core workflow execution engine. Orchestrates step scheduling,
 * dependency resolution, parallel execution, retry logic, and state management
 * for a complete workflow run.
 *
 * ## Architecture Overview
 *
 * The executor implements a **dependency-driven scheduler**:
 *
 * 1. On each tick (loop iteration), it scans all pending steps and determines
 *    which ones are now "ready" — meaning all their dependencies are in `ok`
 *    status (or `skipped` for optional deps, or OK for optional failed deps).
 *
 * 2. Ready steps that fit within the concurrency limit are launched immediately.
 *    Launched steps run in background (Promises); the loop doesn't await them.
 *
 * 3. The loop uses a simple poll-sleep approach rather than event-driven callbacks.
 *    This is intentional: it's simpler to reason about, tolerates step-runner
 *    failures gracefully, and the `TICK_INTERVAL` (500ms) is imperceptible.
 *
 * 4. When a step completes (via `stepPromises` resolution), the scheduler loop
 *    picks it up on the next tick and re-evaluates readiness.
 *
 * ## Dependency Resolution Rules
 *   - A step is ready when all `depends_on` steps have reached terminal state
 *   - Terminal states: `ok`, `failed` (only if optional), `skipped`
 *   - If a non-optional dependency fails, all transitively-dependent steps are
 *     marked `skipped` (not failed) — this prevents false failure counts
 *
 * ## Retry Logic
 *   - On failure, if `step.retry > 0` and `attempts < retry + 1`, re-queue the step
 *   - Wait `step.retry_delay` seconds before re-queuing
 *   - After all retries exhausted, mark as `failed`
 *
 * Dependencies: node:timers/promises, ./workflow-state.js, ./variable-substitution.js
 *
 * @example
 * import { executeWorkflow } from './workflow-executor.js';
 * const finalState = await executeWorkflow(workflowDef, runId, api, config, stepRunner);
 */

import { setTimeout as sleep } from 'node:timers/promises';
import {
  createRunState, updateRunState, updateStepState, saveRunState,
} from './workflow-state.js';
import { buildContext, substituteDeep } from './variable-substitution.js';

/** Scheduler tick interval in milliseconds. Lower = more responsive but more CPU. */
const TICK_INTERVAL_MS = 500;

/**
 * @typedef {Object} ExecutorConfig
 * @property {string}   runsDir        - Directory for state files
 * @property {string}   baseDir        - Base directory for output path resolution
 * @property {number}   concurrency    - Max parallel steps (from workflow or config)
 * @property {string}   [notifyChannel]  - Channel to send notifications to
 * @property {number}   [pollIntervalMs] - Poll interval for step runners
 * @property {string}   [defaultModel]   - Default model for steps without a model
 * @property {Function} [notify]         - Function(message) for sending notifications
 */

/**
 * Execute a workflow run to completion.
 *
 * This is the main entry point for the execution engine. It:
 *   1. Creates initial run state
 *   2. Runs the scheduling loop until all steps complete or the run is cancelled
 *   3. Marks the run as completed (ok, failed, or cancelled)
 *   4. Returns the final run state
 *
 * This function is intentionally async and long-running. The `workflow_run` tool
 * launches it in the background (not awaited) and returns immediately with the run_id.
 *
 * @param {import('./workflow-loader.js').WorkflowDefinition} workflow - Workflow definition
 * @param {string}         runId        - Pre-generated run ID
 * @param {Object}         api          - OpenClaw plugin api
 * @param {ExecutorConfig} config       - Executor configuration
 * @param {Function}       stepRunner   - Step runner function (injectable for testing)
 * @returns {Promise<import('./workflow-state.js').RunState>} Final run state
 *
 * @example
 * const finalState = await executeWorkflow(
 *   workflow,
 *   'seo-pipeline-20260309T082000',
 *   api,
 *   { runsDir, baseDir, concurrency: 3, notify: (msg) => console.log(msg) },
 *   runStep
 * );
 */
export async function executeWorkflow(workflow, runId, api, config, stepRunner, initialState = null) {
  const {
    runsDir,
    baseDir,
    concurrency,
    notify = () => {},
    pollIntervalMs = 5000,
    defaultModel,
  } = config;

  // Build substitution context once for the entire run
  const varCtx = buildContext(runId);

  // Apply variable substitution to all step fields (task prompts, output paths)
  const steps = workflow.steps.map(step => substituteDeep(step, varCtx));

  // Initialize run state — either use a provided initial state (for resume) or create fresh.
  // When resuming, the initialState already has 'ok' steps pre-populated so they are skipped.
  let state = initialState
    ? { ...initialState, run_id: runId }
    : createRunState(workflow.name, steps.map(s => s.id), runId);

  // Transition run to 'running' immediately (overwrites 'pending' from fresh create,
  // or re-sets 'failed'/'cancelled' to 'running' for a resume scenario)
  state = await updateRunState(state, { status: 'running', completed_at: null }, runsDir);

  // Map of step ID → Promise (for in-flight steps)
  /** @type {Map<string, Promise<void>>} */
  const inFlight = new Map();

  // Map of step ID → retry timer handle (so we can cancel on workflow cancel)
  /** @type {Map<string, ReturnType<setTimeout>>} */
  const retryTimers = new Map();

  // Step definitions keyed by ID for O(1) lookup
  const stepMap = new Map(steps.map(s => [s.id, s]));

  /**
   * Determine if a step's dependencies are all satisfied.
   * A dependency is satisfied if:
   *   - It is 'ok', OR
   *   - It is 'skipped' (downstream of a failure), OR
   *   - It is 'failed' and marked optional
   *
   * @param {import('./workflow-loader.js').WorkflowStep} step
   * @returns {{ ready: boolean, blocked: boolean }}
   *   ready: true if all deps are satisfied (step can run)
   *   blocked: true if a non-optional dependency failed (step should be skipped)
   */
  function evalDependencies(step) {
    for (const depId of step.depends_on) {
      const depState = state.steps[depId];
      if (!depState) continue; // Shouldn't happen after validation, but be safe

      const depDef = stepMap.get(depId);
      const isOptional = depDef?.optional === true;

      if (depState.status === 'ok') continue;
      if (depState.status === 'skipped') continue;
      if (depState.status === 'failed' && isOptional) continue;
      if (depState.status === 'failed' && !isOptional) {
        return { ready: false, blocked: true };
      }
      // 'pending' or 'running' — not ready yet
      return { ready: false, blocked: false };
    }
    return { ready: true, blocked: false };
  }

  /**
   * Mark a step and all steps transitively depending on it as 'skipped'.
   * Called when a non-optional dependency fails.
   * State is saved after marking all skipped steps in one pass.
   *
   * @param {string} failedStepId - The step that failed
   */
  async function cascadeSkip(failedStepId) {
    const toSkip = [];
    // BFS to find all downstream steps
    const queue = [failedStepId];
    const visited = new Set();

    while (queue.length > 0) {
      const current = queue.shift();
      for (const step of steps) {
        if (step.depends_on.includes(current) && !visited.has(step.id)) {
          const currentStatus = state.steps[step.id]?.status;
          if (currentStatus === 'pending') {
            visited.add(step.id);
            toSkip.push(step.id);
            queue.push(step.id);
          }
        }
      }
    }

    for (const stepId of toSkip) {
      state = await updateStepState(state, stepId, { status: 'skipped' }, runsDir);
    }
  }

  /**
   * Launch a single step as a background Promise.
   * Updates state to 'running', runs the step, then handles the result.
   *
   * @param {import('./workflow-loader.js').WorkflowStep} step
   */
  function launchStep(step) {
    // Increment attempts before launch
    const attempts = (state.steps[step.id]?.attempts || 0) + 1;

    const promise = (async () => {
      // Mark as running inside the promise so inFlight is set before this runs
      state = await updateStepState(state, step.id, {
        status: 'running',
        started_at: new Date().toISOString(),
        attempts,
      }, runsDir);

      let result;
      try {
        result = await stepRunner(step, runId, api, {
          pollIntervalMs,
          baseDir,
          defaultModel,
        });
      } catch (err) {
        result = {
          status: 'failed',
          session_key: null,
          output_check: { passed: false, missing_files: [], checked_files: [] },
          error: err.message,
          duration_ms: 0,
        };
      }

      const completedAt = new Date().toISOString();
      const startedAt = state.steps[step.id]?.started_at;
      const durationMs = result.duration_ms ||
        (startedAt ? Date.now() - new Date(startedAt).getTime() : 0);

      if (result.status === 'ok') {
        // Success path
        state = await updateStepState(state, step.id, {
          status: 'ok',
          completed_at: completedAt,
          duration_ms: durationMs,
          session_key: result.session_key,
          output_check: result.output_check,
          error: null,
          attempts,
        }, runsDir);

        const durationSec = Math.round(durationMs / 1000);
        await notify(`✅ ${step.name} complete (${durationSec}s)`);

      } else {
        // Failure path — check for retry
        const maxAttempts = step.retry + 1;
        const shouldRetry = attempts < maxAttempts;

        if (shouldRetry) {
          // Notify retry, schedule re-launch after retry_delay
          const nextAttempt = attempts + 1;
          await notify(`❌ ${step.name} failed — retrying (attempt ${nextAttempt}/${maxAttempts})`);

          // Mark as pending again so the scheduler will re-launch
          state = await updateStepState(state, step.id, {
            status: 'pending',
            error: result.error,
            attempts, // keep the attempt count so we know we've retried
          }, runsDir);

          // Schedule re-launch after retry_delay seconds
          // We use a flag on the step state to signal "ready to retry"
          await new Promise(resolve => {
            const timer = setTimeout(() => {
              retryTimers.delete(step.id);
              resolve();
            }, step.retry_delay * 1000);
            retryTimers.set(step.id, timer);
          });

          // After the delay, the scheduler loop will detect the step as
          // 'pending' and re-launch it. But we need to ensure the attempts
          // counter is preserved. We handle this by storing attempts in state.

        } else {
          // All retries exhausted — mark as failed
          state = await updateStepState(state, step.id, {
            status: 'failed',
            completed_at: completedAt,
            duration_ms: durationMs,
            session_key: result.session_key,
            output_check: result.output_check,
            error: result.error,
            attempts,
          }, runsDir);

          const wasRetried = step.retry > 0;
          if (wasRetried) {
            await notify(`❌ ${step.name} failed after ${attempts} attempt(s): ${result.error}`);
          } else {
            await notify(`❌ ${step.name} failed: ${result.error}`);
          }

          // If not optional, cascade skip to dependent steps
          if (!step.optional) {
            await cascadeSkip(step.id);
          } else {
            // Optional failure — log it but don't cascade
            await notify(`⚠️  ${step.name} failed (optional — continuing pipeline)`);
          }
        }
      }

      // Remove from in-flight map when done (whether ok, failed, or retrying)
      inFlight.delete(step.id);

    })();

    inFlight.set(step.id, promise);
  }

  // ── Main scheduling loop ───────────────────────────────────────────────────
  // Runs until all steps reach a terminal state or the run is cancelled.
  let iterationGuard = 0;
  const MAX_ITERATIONS = 100000; // Safety valve against infinite loops

  while (iterationGuard++ < MAX_ITERATIONS) {
    // Re-read state from disk to pick up external cancellation signals
    // (Do this every ~10 ticks to avoid excessive I/O; in-flight updates
    //  are already applied to our local `state` variable.)
    if (iterationGuard % 10 === 0) {
      try {
        const { readRunState } = await import('./workflow-state.js');
        const diskState = await readRunState(runId, runsDir);
        if (diskState.status === 'cancelled') {
          // External cancel — drain in-flight steps and exit
          await Promise.allSettled([...inFlight.values()]);
          for (const timer of retryTimers.values()) clearTimeout(timer);
          return diskState;
        }
      } catch {
        // If we can't read the state file, continue with in-memory state
      }
    }

    // Check if all steps have reached terminal status
    const allTerminal = steps.every(s => {
      const status = state.steps[s.id]?.status;
      return ['ok', 'failed', 'skipped'].includes(status);
    });

    if (allTerminal) break;

    // Launch ready steps up to concurrency limit
    // Count actively running steps (exclude those sleeping through retry delay)
    const currentlyRunning = inFlight.size;

    const slotsAvailable = concurrency - currentlyRunning;

    if (slotsAvailable > 0) {
      // Find all pending steps that could be launched
      for (const step of steps) {
        if (inFlight.size >= concurrency) break;
        if (state.steps[step.id]?.status !== 'pending') continue;
        if (inFlight.has(step.id)) continue; // Already tracked

        const { ready, blocked } = evalDependencies(step);

        if (blocked) {
          // Dep failed and not optional — skip this step
          await updateStepState(state, step.id, { status: 'skipped' }, runsDir)
            .then(ns => { state = ns; });
          continue;
        }

        if (ready) {
          launchStep(step);
        }
      }
    }

    // Wait before next tick
    await sleep(TICK_INTERVAL_MS);
  }

  // Wait for any remaining in-flight promises to settle
  await Promise.allSettled([...inFlight.values()]);

  // ── Determine final run status ─────────────────────────────────────────────
  // Only non-optional step failures cause the pipeline to fail.
  // Optional step failures are expected and don't block dependents or
  // count against the overall pipeline result.
  const finalStepStatuses = Object.values(state.steps).map(s => s.status);
  const anyNonOptionalFailed = steps.some(s => {
    const stepState = state.steps[s.id];
    return !s.optional && stepState?.status === 'failed';
  });
  const finalStatus = anyNonOptionalFailed ? 'failed' : 'ok';

  state = await updateRunState(state, {
    status: finalStatus,
    completed_at: new Date().toISOString(),
  }, runsDir);

  // ── Final notification ─────────────────────────────────────────────────────
  const okCount = finalStepStatuses.filter(s => s === 'ok').length;
  const totalCount = steps.length;

  if (finalStatus === 'ok') {
    await notify(`🏁 Pipeline "${workflow.name}" complete — ${okCount}/${totalCount} steps passed`);
  } else {
    const failedCount = finalStepStatuses.filter(s => s === 'failed').length;
    await notify(
      `💥 Pipeline "${workflow.name}" failed — ${failedCount} step(s) failed, ${okCount}/${totalCount} passed`
    );
  }

  return state;
}

/**
 * Resume a previously failed or partial workflow run.
 * Resets steps that previously failed (or were skipped due to failures)
 * back to 'pending' so they can be retried, while keeping 'ok' steps intact.
 *
 * @param {import('./workflow-state.js').RunState} previousState - State from previous run
 * @param {import('./workflow-loader.js').WorkflowDefinition} workflow - Workflow definition
 * @param {string} newRunId - New run ID for this resume attempt
 * @param {Object} api - OpenClaw plugin api
 * @param {ExecutorConfig} config - Executor configuration
 * @param {Function} stepRunner - Step runner function
 * @returns {Promise<import('./workflow-state.js').RunState>}
 *
 * @example
 * // Resume after a partial failure:
 * const finalState = await resumeWorkflow(failedState, workflow, newRunId, api, config, stepRunner);
 */
export async function resumeWorkflow(previousState, workflow, newRunId, api, config, stepRunner) {
  const { runsDir } = config;

  // Build a new state based on the previous one, resetting non-ok steps.
  // Steps that were 'ok' in the previous run are preserved — they'll be
  // skipped by the executor's scheduler loop (which only launches 'pending' steps).
  let state = createRunState(
    workflow.name,
    workflow.steps.map(s => s.id),
    newRunId,
  );

  // Copy over 'ok' steps from previous run (preserve their results)
  for (const [stepId, stepState] of Object.entries(previousState.steps)) {
    if (stepState.status === 'ok') {
      state.steps[stepId] = { ...stepState };
    }
    // All other statuses (failed, skipped, running) remain as 'pending' (reset to retry)
  }

  // Save the bootstrapped state before running so it's on disk for status checks
  await saveRunState(state, runsDir);

  // Pass initialState so executeWorkflow doesn't overwrite our pre-seeded ok steps
  return executeWorkflow(workflow, newRunId, api, config, stepRunner, state);
}

/**
 * Perform a dry run — validate the workflow and report what would execute.
 * Does not spawn any sessions or write any run state.
 *
 * @param {import('./workflow-loader.js').WorkflowDefinition} workflow - Workflow definition
 * @param {string} runId - The run ID that would be used
 * @returns {Object} Dry run report with execution plan
 *
 * @example
 * const report = dryRun(workflow, 'seo-pipeline-20260309T082000');
 * console.log(report.execution_plan);
 */
export function dryRun(workflow, runId) {
  const varCtx = buildContext(runId);
  const steps = workflow.steps.map(step => substituteDeep(step, varCtx));

  // Build execution waves (steps with no unresolved deps execute together)
  const waves = [];
  const completed = new Set();
  let remaining = [...steps];

  while (remaining.length > 0) {
    const wave = remaining.filter(step =>
      step.depends_on.every(dep => completed.has(dep))
    );

    if (wave.length === 0) {
      // Shouldn't happen after cycle detection in loader, but be defensive
      break;
    }

    waves.push(wave.map(s => ({
      id: s.id,
      name: s.name,
      model: s.model,
      timeout_s: s.timeout,
      retry: s.retry,
      optional: s.optional,
      outputs: s.outputs,
    })));

    wave.forEach(s => completed.add(s.id));
    remaining = remaining.filter(s => !completed.has(s.id));
  }

  return {
    run_id: runId,
    workflow: workflow.name,
    description: workflow.description,
    total_steps: steps.length,
    concurrency: workflow.concurrency,
    execution_waves: waves,
    estimated_min_duration_s: waves.reduce((sum, wave) => {
      const maxTimeout = Math.max(...wave.map(s => s.timeout_s));
      return sum + maxTimeout;
    }, 0),
    variable_context: varCtx,
  };
}
