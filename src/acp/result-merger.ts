/**
 * Result Merger: combines outputs from multiple sub-agents into a final deliverable.
 *
 * Part of the Perplexity Computer-style parallel sub-agent architecture.
 * After all sub-agents complete, the merger assembles their outputs into a
 * coherent, well-structured final result.
 */

import type { TaskResult } from "./task-planner.js";
import type { PlannedTask, TaskPlan } from "./task-planner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MergeStrategy =
  | "sequential" // Concatenate in dependency order (default)
  | "summary"    // Produce a high-level summary
  | "code"       // Merge code artifacts (files + tests + docs)
  | "report";    // Merge into a structured report with sections

export type MergedResult = {
  planId: string;
  goal: string;
  strategy: MergeStrategy;
  output: string;
  taskSummaries: TaskSummary[];
  failedTasks: string[];
  completedAt: number;
};

type TaskSummary = {
  label: string;
  status: string;
  outputSnippet?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function resolveMergeStrategy(plan: TaskPlan): MergeStrategy {
  const goal = plan.goal.toLowerCase();
  if (/\b(code|implement|build|develop|script)\b/i.test(goal)) return "code";
  if (/\b(report|article|essay|summary|blog)\b/i.test(goal)) return "report";
  if (/\b(summarize|overview|brief|tldr)\b/i.test(goal)) return "summary";
  return "sequential";
}

function getTaskOrder(plan: TaskPlan): PlannedTask[] {
  // Topological sort using Kahn's algorithm
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const task of plan.tasks) {
    inDegree.set(task.id, task.dependsOn.length);
    adj.set(task.id, []);
  }
  for (const task of plan.tasks) {
    for (const depId of task.dependsOn) {
      const list = adj.get(depId) ?? [];
      list.push(task.id);
      adj.set(depId, list);
    }
  }

  const queue = plan.tasks.filter((t) => (inDegree.get(t.id) ?? 0) === 0);
  const sorted: PlannedTask[] = [];
  const taskById = new Map(plan.tasks.map((t) => [t.id, t]));

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const nextId of adj.get(current.id) ?? []) {
      const newDeg = (inDegree.get(nextId) ?? 0) - 1;
      inDegree.set(nextId, newDeg);
      if (newDeg === 0) {
        const next = taskById.get(nextId);
        if (next) queue.push(next);
      }
    }
  }

  return sorted;
}

// ---------------------------------------------------------------------------
// Merge strategies
// ---------------------------------------------------------------------------

function mergeSequential(
  plan: TaskPlan,
  results: Map<string, TaskResult>,
  orderedTasks: PlannedTask[],
): string {
  const parts: string[] = [`# Result: ${plan.goal}`, ""];

  for (const task of orderedTasks) {
    const result = results.get(task.id);
    if (!result || result.status !== "done" || !result.output) continue;
    parts.push(`## ${task.label}`);
    parts.push(result.output.trim());
    parts.push("");
  }

  return parts.join("\n");
}

function mergeSummary(
  plan: TaskPlan,
  results: Map<string, TaskResult>,
  orderedTasks: PlannedTask[],
): string {
  const successfulOutputs = orderedTasks
    .map((t) => results.get(t.id))
    .filter((r) => r?.status === "done" && r.output)
    .map((r) => r!.output!.trim());

  if (successfulOutputs.length === 0) {
    return `No successful outputs to summarize for: ${plan.goal}`;
  }

  const combined = successfulOutputs.join("\n\n---\n\n");
  return `# Summary: ${plan.goal}\n\n${combined}`;
}

function mergeCode(
  plan: TaskPlan,
  results: Map<string, TaskResult>,
  orderedTasks: PlannedTask[],
): string {
  const parts: string[] = [`# Code Project: ${plan.goal}`, ""];

  const specTask = orderedTasks.find((t) => t.label === "design-spec");
  const implTask = orderedTasks.find((t) => t.label === "implement");
  const testTask = orderedTasks.find((t) => t.label === "write-tests");
  const docsTask = orderedTasks.find((t) => t.label === "write-docs");

  if (specTask) {
    const r = results.get(specTask.id);
    if (r?.status === "done" && r.output) {
      parts.push("## Architecture & Specification");
      parts.push(r.output.trim());
      parts.push("");
    }
  }

  if (implTask) {
    const r = results.get(implTask.id);
    if (r?.status === "done" && r.output) {
      parts.push("## Implementation");
      parts.push(r.output.trim());
      parts.push("");
    }
  }

  if (testTask) {
    const r = results.get(testTask.id);
    if (r?.status === "done" && r.output) {
      parts.push("## Tests");
      parts.push(r.output.trim());
      parts.push("");
    }
  }

  if (docsTask) {
    const r = results.get(docsTask.id);
    if (r?.status === "done" && r.output) {
      parts.push("## Documentation");
      parts.push(r.output.trim());
      parts.push("");
    }
  }

  // Any remaining tasks not matched above
  for (const task of orderedTasks) {
    if ([specTask?.id, implTask?.id, testTask?.id, docsTask?.id].includes(task.id)) continue;
    const r = results.get(task.id);
    if (r?.status === "done" && r.output) {
      parts.push(`## ${task.label}`);
      parts.push(r.output.trim());
      parts.push("");
    }
  }

  return parts.join("\n");
}

function mergeReport(
  plan: TaskPlan,
  results: Map<string, TaskResult>,
  orderedTasks: PlannedTask[],
): string {
  const sections = orderedTasks
    .filter((t) => {
      const r = results.get(t.id);
      return r?.status === "done" && r.output;
    })
    .map((t) => {
      const r = results.get(t.id)!;
      return `## ${t.label.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}\n\n${r.output!.trim()}`;
    });

  return [`# ${plan.goal}`, "", ...sections].join("\n\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merges results from all sub-agents into a coherent final output.
 */
export function mergeResults(
  plan: TaskPlan,
  results: Map<string, TaskResult>,
  strategyOverride?: MergeStrategy,
): MergedResult {
  const strategy = strategyOverride ?? resolveMergeStrategy(plan);
  const orderedTasks = getTaskOrder(plan);

  let output: string;
  switch (strategy) {
    case "code":
      output = mergeCode(plan, results, orderedTasks);
      break;
    case "report":
      output = mergeReport(plan, results, orderedTasks);
      break;
    case "summary":
      output = mergeSummary(plan, results, orderedTasks);
      break;
    default:
      output = mergeSequential(plan, results, orderedTasks);
  }

  const taskSummaries: TaskSummary[] = plan.tasks.map((task) => {
    const result = results.get(task.id);
    return {
      label: task.label,
      status: result?.status ?? "pending",
      outputSnippet: result?.output ? truncate(result.output, 120) : undefined,
    };
  });

  const failedTasks = plan.tasks
    .filter((t) => results.get(t.id)?.status === "failed")
    .map((t) => t.label);

  return {
    planId: plan.id,
    goal: plan.goal,
    strategy,
    output,
    taskSummaries,
    failedTasks,
    completedAt: Date.now(),
  };
}
