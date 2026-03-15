/**
 * @module openclaw-workflow
 * @description OpenClaw plugin entry point. Registers four tools that expose
 * the workflow orchestration system to agents:
 *
 *   - workflow_run     Run a workflow by name (async background execution)
 *   - workflow_status  Check the status of a running or completed workflow run
 *   - workflow_list    List all available workflows and their last run status
 *   - workflow_cancel  Cancel a running workflow run
 *
 * ## Plugin Configuration (openclaw.plugin.json configSchema)
 *   workflowsDir   Where workflow YAML/JSON files live (default: ~/.openclaw/workflows/)
 *   runsDir        Where run state files are written (default: ~/.openclaw/workflow-runs/)
 *   baseDir        Base dir for resolving relative output file paths (default: cwd)
 *   concurrency    Max parallel steps per workflow (default: 3)
 *   notifyChannel  Channel to send step notifications (optional)
 *   sessionModel   Default model for steps without an explicit model
 *   pollIntervalMs Polling interval for session status (default: 5000)
 *
 * ## Execution Model
 * `workflow_run` returns immediately with a `run_id` and launches the
 * workflow execution in the background (unawaited Promise). The agent can
 * then use `workflow_status` to poll progress, or rely on channel
 * notifications for each step completion.
 *
 * @example
 * // In an agent session, after this plugin is installed:
 * // workflow_run({ name: 'seo-pipeline' })
 * // → { run_id: 'seo-pipeline-20260309T082000', status: 'running', steps: {...} }
 *
 * Dependencies: ./workflow-loader.js, ./workflow-executor.js, ./workflow-state.js,
 *               ./step-runner.js
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadWorkflow, listWorkflows } from './workflow-loader.js';
import { executeWorkflow, resumeWorkflow, dryRun } from './workflow-executor.js';
import { generateRunId, readRunState, updateRunState, listRuns, findLatestRun } from './workflow-state.js';
import { runStep } from './step-runner.js';

/** Format a tool result in the MCP content format OpenClaw expects. */
function textResult(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

/** Format an error result. */
function errorResult(msg) {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

/**
 * Plugin default export — called by OpenClaw with the plugin api object.
 *
 * @param {Object} api - OpenClaw plugin API
 * @param {Object} [api.pluginConfig]   - Configuration from openclaw.plugin.json schema
 * @param {Function} api.registerTool  - Register a tool with name, description, parameters, execute
 * @param {Object}  [api.sessions]     - Optional: sessions API (spawn, getStatus) — see step-runner.js
 */
export default function (api) {
  const config = api.pluginConfig ?? {};

  // Resolve directories with sane defaults
  /** Expand leading ~/ or ~ safely */
  const expandTilde = (p) => p.startsWith('~/') ? join(homedir(), p.slice(2)) : p === '~' ? homedir() : p;

  const workflowsDir = config.workflowsDir
    ? resolve(expandTilde(config.workflowsDir))
    : join(homedir(), '.openclaw', 'workflows');

  const runsDir = config.runsDir
    ? resolve(expandTilde(config.runsDir))
    : join(homedir(), '.openclaw', 'workflow-runs');

  const baseDir = config.baseDir
    ? resolve(expandTilde(config.baseDir))
    : process.cwd();

  const concurrencyDefault = typeof config.concurrency === 'number' ? config.concurrency : 3;
  const pollIntervalMs = typeof config.pollIntervalMs === 'number' ? config.pollIntervalMs : 5000;
  const defaultModel = config.sessionModel || null;

  /**
   * Build the executor config object for a workflow run.
   * Merges plugin-level config with workflow-level concurrency.
   *
   * @param {import('./workflow-loader.js').WorkflowDefinition} workflow
   * @param {Function} notifyFn - Channel notification function
   * @returns {import('./workflow-executor.js').ExecutorConfig}
   */
  function buildExecutorConfig(workflow, notifyFn) {
    return {
      runsDir,
      baseDir,
      concurrency: workflow.concurrency ?? concurrencyDefault,
      notify: notifyFn,
      pollIntervalMs,
      defaultModel,
    };
  }

  /**
   * Build a notification function that sends messages to the configured channel.
   * If notifyChannel is not configured, the function is a no-op.
   *
   * We use dynamic import to avoid a hard dependency on the message-sending
   * system — this keeps the plugin self-contained and testable.
   *
   * @returns {Function} async notify(message: string) => void
   */
  function buildNotifier() {
    if (!config.notifyChannel) {
      return () => Promise.resolve();
    }
    return async (message) => {
      // The api object may expose a notify/send method in future versions.
      // For now, log to stdout — the OpenClaw host captures plugin stdout
      // and may route it to configured channels.
      console.log(`[workflow-notify:${config.notifyChannel}] ${message}`);
    };
  }

  // ── TOOL: workflow_run ─────────────────────────────────────────────────────

  api.registerTool({
    name: 'workflow_run',
    description:
      'Run a named workflow. Loads the workflow definition from the configured workflows directory, ' +
      'validates it, and begins async execution. Returns immediately with a run_id — use workflow_status ' +
      'to check progress. Supports dry_run (validate without executing) and resume (skip already-completed steps).',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Workflow file stem (e.g. "seo-pipeline" for seo-pipeline.yml)',
        },
        dry_run: {
          type: 'boolean',
          description:
            'If true, validate and show execution plan without running. Default: false.',
        },
        resume: {
          type: 'boolean',
          description:
            'If true, resume from the most recent run — skip steps that already have status "ok". Default: false.',
        },
      },
      required: ['name'],
    },

    async execute(_agentId, { name, dry_run = false, resume = false }) {
      try {
        // 1. Load and validate the workflow definition
        const workflow = await loadWorkflow(name, workflowsDir);

        // 2. Generate a run ID
        const runId = generateRunId(workflow.name);

        // 3. Dry run: validate + report execution plan, don't execute
        if (dry_run) {
          const plan = dryRun(workflow, runId);
          return textResult({
            dry_run: true,
            message: `Workflow "${workflow.name}" is valid. ${workflow.steps.length} step(s) would run.`,
            ...plan,
          });
        }

        const notify = buildNotifier();
        const execConfig = buildExecutorConfig(workflow, notify);

        // 4. Resume mode: load last run state and pass to resumeWorkflow
        if (resume) {
          const lastRun = await findLatestRun(workflow.name, runsDir);
          if (!lastRun) {
            return errorResult(
              `No previous run found for workflow "${name}" to resume from. ` +
              `Run without resume:true to start fresh.`
            );
          }

          // Launch resume in background (don't await)
          resumeWorkflow(lastRun, workflow, runId, api, execConfig, runStep)
            .catch(err => console.error(`[workflow:${runId}] resume error:`, err));

          const skippedSteps = Object.entries(lastRun.steps)
            .filter(([, s]) => s.status === 'ok')
            .map(([id]) => id);

          return textResult({
            run_id: runId,
            status: 'running',
            resumed_from: lastRun.run_id,
            skipped_steps: skippedSteps,
            message: `Workflow "${workflow.name}" resumed. ${skippedSteps.length} step(s) skipped (already ok). Use workflow_status to track progress.`,
          });
        }

        // 5. Fresh run: launch in background (don't await)
        executeWorkflow(workflow, runId, api, execConfig, runStep)
          .catch(err => console.error(`[workflow:${runId}] execution error:`, err));

        // Build initial step summary for the response
        const stepSummary = {};
        for (const step of workflow.steps) {
          stepSummary[step.id] = { status: 'pending', depends_on: step.depends_on };
        }

        return textResult({
          run_id: runId,
          workflow: workflow.name,
          status: 'running',
          total_steps: workflow.steps.length,
          steps: stepSummary,
          message: `Workflow "${workflow.name}" started. Use workflow_status with run_id "${runId}" to track progress.`,
        });

      } catch (err) {
        return errorResult(err.message);
      }
    },
  });

  // ── TOOL: workflow_status ──────────────────────────────────────────────────

  api.registerTool({
    name: 'workflow_status',
    description:
      'Check the status of a workflow run. Provide run_id for a specific run, or name to get the most recent run for that workflow.',
    parameters: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'Specific run ID to look up (e.g. "seo-pipeline-20260309T082000")',
        },
        name: {
          type: 'string',
          description: 'Workflow name — returns the status of the most recent run for this workflow.',
        },
      },
    },

    async execute(_agentId, { run_id, name }) {
      try {
        let state;

        if (run_id) {
          state = await readRunState(run_id, runsDir);
        } else if (name) {
          // name may be a file stem — load the workflow to get its display name
          let displayName = name;
          try {
            const wf = await loadWorkflow(name, workflowsDir);
            displayName = wf.name;
          } catch { /* fall back to raw name */ }
          state = await findLatestRun(displayName, runsDir);
          if (!state) {
            return errorResult(`No runs found for workflow "${name}"`);
          }
        } else {
          return errorResult('Provide either run_id or name');
        }

        // Build a human-friendly summary
        const stepSummary = {};
        for (const [stepId, stepState] of Object.entries(state.steps)) {
          stepSummary[stepId] = {
            status: stepState.status,
            attempts: stepState.attempts,
            duration_s: stepState.duration_ms ? Math.round(stepState.duration_ms / 1000) : null,
            error: stepState.error,
            started_at: stepState.started_at,
            completed_at: stepState.completed_at,
          };
        }

        // Calculate elapsed time
        const elapsedMs = state.started_at
          ? (state.completed_at ? new Date(state.completed_at) : new Date()) - new Date(state.started_at)
          : null;

        const okCount = Object.values(state.steps).filter(s => s.status === 'ok').length;
        const failedCount = Object.values(state.steps).filter(s => s.status === 'failed').length;
        const totalCount = Object.keys(state.steps).length;

        return textResult({
          run_id: state.run_id,
          workflow: state.workflow,
          status: state.status,
          started_at: state.started_at,
          completed_at: state.completed_at,
          elapsed_s: elapsedMs ? Math.round(elapsedMs / 1000) : null,
          steps_ok: okCount,
          steps_failed: failedCount,
          steps_total: totalCount,
          steps: stepSummary,
        });

      } catch (err) {
        if (err.code === 'ENOENT') {
          return errorResult(`Run not found: ${run_id || name}`);
        }
        return errorResult(err.message);
      }
    },
  });

  // ── TOOL: workflow_list ────────────────────────────────────────────────────

  api.registerTool({
    name: 'workflow_list',
    description:
      'List all available workflow definition files and their most recent run status. ' +
      'Scans the configured workflows directory for .yml, .yaml, and .json files.',
    parameters: {
      type: 'object',
      properties: {},
    },

    async execute(_agentId, _params) {
      try {
        const availableWorkflows = await listWorkflows(workflowsDir);

        // Enrich each workflow with last run info
        const enriched = await Promise.all(
          availableWorkflows.map(async (wf) => {
            const lastRun = await findLatestRun(wf.name, runsDir);
            return {
              name: wf.name,
              display_name: wf.displayName || wf.name,
              description: wf.description,
              file: wf.filePath,
              last_run: lastRun
                ? {
                    run_id: lastRun.run_id,
                    status: lastRun.status,
                    started_at: lastRun.started_at,
                    completed_at: lastRun.completed_at,
                  }
                : null,
            };
          })
        );

        return textResult({
          workflows_dir: workflowsDir,
          count: enriched.length,
          workflows: enriched,
        });

      } catch (err) {
        return errorResult(err.message);
      }
    },
  });

  // ── TOOL: workflow_cancel ──────────────────────────────────────────────────

  api.registerTool({
    name: 'workflow_cancel',
    description:
      'Cancel a running workflow. In-flight steps are allowed to finish, but no new steps will start. ' +
      'Has no effect on runs that are already completed.',
    parameters: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'The run ID to cancel (from workflow_run or workflow_status)',
        },
      },
      required: ['run_id'],
    },

    async execute(_agentId, { run_id }) {
      try {
        const state = await readRunState(run_id, runsDir);

        if (['ok', 'failed', 'cancelled'].includes(state.status)) {
          return textResult({
            run_id,
            message: `Run "${run_id}" is already in terminal state "${state.status}" — nothing to cancel.`,
          });
        }

        // Write 'cancelled' status to the state file.
        // The executor polls disk state every ~5 seconds and will stop launching
        // new steps when it sees the cancelled flag.
        const updatedState = await updateRunState(state, {
          status: 'cancelled',
          completed_at: new Date().toISOString(),
        }, runsDir);

        const inFlightSteps = Object.entries(updatedState.steps)
          .filter(([, s]) => s.status === 'running')
          .map(([id]) => id);

        return textResult({
          run_id,
          status: 'cancelled',
          message: `Run "${run_id}" marked as cancelled. ${inFlightSteps.length > 0
            ? `${inFlightSteps.length} step(s) currently in-flight will complete: ${inFlightSteps.join(', ')}`
            : 'No steps currently running.'}`,
        });

      } catch (err) {
        if (err.code === 'ENOENT') {
          return errorResult(`Run not found: ${run_id}`);
        }
        return errorResult(err.message);
      }
    },
  });
}
