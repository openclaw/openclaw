/**
 * Sub-Agent Orchestrator: Perplexity Computer-style parallel workflow engine.
 *
 * Takes a user goal, decomposes it into a DAG of tasks using the task planner,
 * spawns sub-agents in parallel (respecting dependencies), collects results,
 * and merges them into a final deliverable using the result merger.
 *
 * Key properties:
 * - Tasks without dependencies run in parallel
 * - Tasks with dependencies start only when all deps are done
 * - Sub-agents can recursively spawn their own sub-agents
 * - Real-time progress tracking via callbacks
 * - Error recovery: failed tasks are logged, plan continues
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { RouterOptions } from "../routing/model-router.js";
import { routeTask } from "../routing/model-router.js";
import type { MergeStrategy, MergedResult } from "./result-merger.js";
import { mergeResults } from "./result-merger.js";
import type { PlannedTask, TaskPlan, TaskResult } from "./task-planner.js";
import {
  decomposeGoal,
  formatPlanProgress,
  getReadyTasks,
  isPlanComplete,
} from "./task-planner.js";

const log = createSubsystemLogger("acp/orchestrator");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubAgentRunner = (params: {
  task: string;
  label: string;
  provider?: string;
  model?: string;
}) => Promise<string>;

export type OrchestratorOptions = {
  /** Custom sub-agent runner; defaults to a stub that returns the task description. */
  runner?: SubAgentRunner;
  /** Router options for model selection. */
  routerOptions?: RouterOptions;
  /** Max sub-agents running in parallel (default: 5). */
  maxConcurrency?: number;
  /** Merge strategy override. */
  mergeStrategy?: MergeStrategy;
  /** Called when a task changes status. */
  onProgress?: (progress: string) => void;
  /** Called when a task starts. */
  onTaskStart?: (task: PlannedTask) => void;
  /** Called when a task completes. */
  onTaskComplete?: (task: PlannedTask, result: TaskResult) => void;
};

export type OrchestratorResult = {
  plan: TaskPlan;
  merged: MergedResult;
  results: Record<string, TaskResult>;
};

// ---------------------------------------------------------------------------
// Orchestration engine
// ---------------------------------------------------------------------------

/**
 * Default stub runner — replaces with real ACP spawn integration when used
 * in production. Sub-agents call `spawnAcpDirect` or `runWithModelFallback`
 * in the actual gateway.
 */
async function defaultRunner(params: {
  task: string;
  label: string;
  provider?: string;
  model?: string;
}): Promise<string> {
  log.debug(`[stub] Running sub-agent: ${params.label} on ${params.provider}/${params.model}`);
  // In production this is replaced by real agent execution
  return `[${params.label}] Task completed: ${params.task.slice(0, 100)}`;
}

async function runTask(
  task: PlannedTask,
  runner: SubAgentRunner,
  routerOptions?: RouterOptions,
): Promise<TaskResult> {
  const startedAt = Date.now();
  try {
    // Route to the best model for this task type
    const routing = task.modelHint
      ? { provider: "anthropic", model: task.modelHint }
      : routeTask(task.description, {
          ...routerOptions,
          latencyBudget: routerOptions?.latencyBudget ?? "normal",
        });

    const output = await runner({
      task: task.description,
      label: task.label,
      provider: routing.provider,
      model: routing.model,
    });

    return {
      taskId: task.id,
      status: "done",
      output,
      startedAt,
      completedAt: Date.now(),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn(`Task "${task.label}" failed: ${error}`);
    return {
      taskId: task.id,
      status: "failed",
      error,
      startedAt,
      completedAt: Date.now(),
    };
  }
}

/**
 * Runs an orchestrated workflow for a given goal.
 *
 * Algorithm:
 * 1. Decompose goal into task DAG
 * 2. While plan is not complete:
 *    a. Find all ready tasks (dependencies done, not yet started)
 *    b. Launch up to maxConcurrency tasks in parallel
 *    c. Wait for at least one to complete, then re-check readiness
 * 3. Merge all results into final output
 */
export async function orchestrate(
  goal: string,
  opts: OrchestratorOptions = {},
): Promise<OrchestratorResult> {
  const runner = opts.runner ?? defaultRunner;
  const maxConcurrency = opts.maxConcurrency ?? 5;

  // 1. Decompose goal
  const plan = decomposeGoal(goal);
  log.info(`Orchestrating goal: ${goal} (${plan.tasks.length} tasks)`);

  const results = new Map<string, TaskResult>();
  const inFlight = new Set<string>(); // task IDs currently running

  // 2. Execute tasks respecting DAG dependencies
  while (!isPlanComplete(plan, results)) {
    const ready = getReadyTasks(plan, results).filter((t) => !inFlight.has(t.id));
    const slots = maxConcurrency - inFlight.size;
    const toStart = ready.slice(0, slots);

    if (toStart.length === 0 && inFlight.size === 0) {
      // No tasks ready and nothing in flight — deadlock (circular deps or all failed)
      log.warn("Orchestration stalled — marking remaining tasks as skipped");
      for (const task of plan.tasks) {
        if (!results.has(task.id)) {
          results.set(task.id, { taskId: task.id, status: "skipped" });
        }
      }
      break;
    }

    // Start ready tasks
    const promises: Promise<void>[] = [];
    for (const task of toStart) {
      inFlight.add(task.id);
      opts.onTaskStart?.(task);

      const promise = runTask(task, runner, opts.routerOptions).then((result) => {
        results.set(task.id, result);
        inFlight.delete(task.id);
        opts.onTaskComplete?.(task, result);

        if (opts.onProgress) {
          opts.onProgress(formatPlanProgress(plan, results));
        }
      });
      promises.push(promise);
    }

    // Wait for at least one task to complete before re-checking
    if (promises.length > 0) {
      await Promise.race(promises);
    } else if (inFlight.size > 0) {
      // All slots full — wait for any in-flight to finish
      // This is handled naturally by the outer while loop checking inFlight
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // 3. Merge results
  const merged = mergeResults(plan, results, opts.mergeStrategy);

  log.info(
    `Orchestration complete: ${merged.taskSummaries.filter((t) => t.status === "done").length}/${plan.tasks.length} tasks succeeded`,
  );

  return {
    plan,
    merged,
    results: Object.fromEntries([...results.entries()].map(([k, v]) => [k, v])),
  };
}

/**
 * Returns a quick summary of what the orchestrator would do for a goal,
 * without actually executing anything. Useful for previewing plans.
 */
export function previewPlan(goal: string): string {
  const plan = decomposeGoal(goal);
  const empty = new Map<string, TaskResult>();
  return formatPlanProgress(plan, empty);
}
