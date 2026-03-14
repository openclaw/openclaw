/**
 * Task Planner: decomposes a high-level goal into a DAG of subtasks.
 *
 * Each subtask has:
 *  - a label and description
 *  - a task type hint (code, research, creative, etc.)
 *  - a list of dependency task IDs (must complete before this starts)
 *  - an optional model hint
 *
 * This is the Perplexity Computer-style "break goal into tasks and subtasks"
 * feature that drives parallel sub-agent execution.
 */

import crypto from "node:crypto";
import type { ModelTaskType } from "../routing/model-capabilities.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type PlannedTask = {
  id: string;
  label: string;
  description: string;
  taskType: ModelTaskType;
  /** IDs of tasks that must complete before this one starts. */
  dependsOn: string[];
  /** Optional explicit model override for this subtask. */
  modelHint?: string;
  /** Whether this task requires user confirmation before execution. */
  requiresConfirmation?: boolean;
  /** Whether this task is destructive (e.g., delete, publish, purchase). */
  isDestructive?: boolean;
};

export type TaskPlan = {
  id: string;
  goal: string;
  tasks: PlannedTask[];
  createdAt: number;
};

export type TaskResult = {
  taskId: string;
  status: TaskStatus;
  output?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
};

// ---------------------------------------------------------------------------
// Built-in task templates
// ---------------------------------------------------------------------------

/**
 * Heuristic-based task decomposition for common goal patterns.
 * For production use, you'd send the goal to an LLM with a planning prompt,
 * but this covers common workflows without additional API calls.
 */
function detectGoalPattern(goal: string): "research-report" | "code-project" | "data-pipeline" | "content-creation" | "generic" {
  const lower = goal.toLowerCase();

  if (/\b(write|draft|create|compose)\b.*\b(report|article|blog|essay|summary)\b/i.test(lower)) {
    return "research-report";
  }
  if (/\b(build|create|implement|develop|code|write)\b.*\b(app|application|script|api|service|tool)\b/i.test(lower)) {
    return "code-project";
  }
  if (/\b(analyze|process|transform|clean|pipeline|etl|data)\b/i.test(lower)) {
    return "data-pipeline";
  }
  if (/\b(marketing|campaign|content|social media|post|newsletter)\b/i.test(lower)) {
    return "content-creation";
  }
  return "generic";
}

function makeId(): string {
  return crypto.randomUUID().slice(0, 8);
}

// ---------------------------------------------------------------------------
// Decomposition functions
// ---------------------------------------------------------------------------

function planResearchReport(goal: string): PlannedTask[] {
  const gather = makeId();
  const outline = makeId();
  const write = makeId();
  const review = makeId();

  return [
    {
      id: gather,
      label: "gather-sources",
      description: `Search the web and gather relevant sources for: ${goal}`,
      taskType: "research",
      dependsOn: [],
    },
    {
      id: outline,
      label: "create-outline",
      description: `Create a structured outline based on gathered sources`,
      taskType: "general",
      dependsOn: [gather],
    },
    {
      id: write,
      label: "write-draft",
      description: `Write the full draft based on the outline and sources`,
      taskType: "creative",
      dependsOn: [outline],
    },
    {
      id: review,
      label: "review-and-finalize",
      description: `Review, edit, and finalize the draft for clarity and accuracy`,
      taskType: "general",
      dependsOn: [write],
    },
  ];
}

function planCodeProject(goal: string): PlannedTask[] {
  const spec = makeId();
  const impl = makeId();
  const test = makeId();
  const docs = makeId();

  return [
    {
      id: spec,
      label: "design-spec",
      description: `Design architecture and spec for: ${goal}`,
      taskType: "reasoning",
      dependsOn: [],
    },
    {
      id: impl,
      label: "implement",
      description: `Implement the code according to the spec`,
      taskType: "code",
      dependsOn: [spec],
    },
    {
      id: test,
      label: "write-tests",
      description: `Write tests and verify the implementation`,
      taskType: "code",
      dependsOn: [impl],
    },
    {
      id: docs,
      label: "write-docs",
      description: `Write documentation and usage examples`,
      taskType: "creative",
      dependsOn: [impl],
    },
  ];
}

function planDataPipeline(goal: string): PlannedTask[] {
  const fetch = makeId();
  const clean = makeId();
  const analyze = makeId();
  const visualize = makeId();

  return [
    {
      id: fetch,
      label: "fetch-data",
      description: `Fetch or load data for: ${goal}`,
      taskType: "research",
      dependsOn: [],
    },
    {
      id: clean,
      label: "clean-data",
      description: `Clean and normalize the fetched data`,
      taskType: "code",
      dependsOn: [fetch],
    },
    {
      id: analyze,
      label: "analyze",
      description: `Analyze the cleaned data and extract insights`,
      taskType: "data-analysis",
      dependsOn: [clean],
    },
    {
      id: visualize,
      label: "visualize",
      description: `Create visualizations and a summary of findings`,
      taskType: "creative",
      dependsOn: [analyze],
    },
  ];
}

function planContentCreation(goal: string): PlannedTask[] {
  const research = makeId();
  const ideate = makeId();
  const draft = makeId();
  const refine = makeId();

  return [
    {
      id: research,
      label: "research-topic",
      description: `Research the topic and audience for: ${goal}`,
      taskType: "research",
      dependsOn: [],
    },
    {
      id: ideate,
      label: "ideate",
      description: `Generate content ideas and angles`,
      taskType: "creative",
      dependsOn: [research],
    },
    {
      id: draft,
      label: "draft-content",
      description: `Draft the content`,
      taskType: "creative",
      dependsOn: [ideate],
    },
    {
      id: refine,
      label: "refine",
      description: `Refine tone, style, and messaging`,
      taskType: "creative",
      dependsOn: [draft],
    },
  ];
}

function planGeneric(goal: string): PlannedTask[] {
  const understand = makeId();
  const execute = makeId();
  const verify = makeId();

  return [
    {
      id: understand,
      label: "understand-goal",
      description: `Analyze and understand the goal: ${goal}`,
      taskType: "reasoning",
      dependsOn: [],
    },
    {
      id: execute,
      label: "execute",
      description: `Execute the main task: ${goal}`,
      taskType: "general",
      dependsOn: [understand],
    },
    {
      id: verify,
      label: "verify-output",
      description: `Verify that the output meets the original goal`,
      taskType: "reasoning",
      dependsOn: [execute],
    },
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decomposes a goal into a plan of subtasks.
 *
 * In a full implementation, this would call an LLM with a planning prompt.
 * Here we use a heuristic-based approach that covers common patterns.
 */
export function decomposeGoal(goal: string): TaskPlan {
  const pattern = detectGoalPattern(goal);
  let tasks: PlannedTask[];

  switch (pattern) {
    case "research-report":
      tasks = planResearchReport(goal);
      break;
    case "code-project":
      tasks = planCodeProject(goal);
      break;
    case "data-pipeline":
      tasks = planDataPipeline(goal);
      break;
    case "content-creation":
      tasks = planContentCreation(goal);
      break;
    default:
      tasks = planGeneric(goal);
  }

  return {
    id: crypto.randomUUID(),
    goal,
    tasks,
    createdAt: Date.now(),
  };
}

/**
 * Returns the set of tasks that are ready to run given the current
 * results map (all dependencies satisfied, not yet started).
 */
export function getReadyTasks(
  plan: TaskPlan,
  results: Map<string, TaskResult>,
): PlannedTask[] {
  return plan.tasks.filter((task) => {
    // Already started or done
    if (results.has(task.id)) return false;
    // All dependencies must be done
    return task.dependsOn.every((depId) => results.get(depId)?.status === "done");
  });
}

/**
 * Returns true if all tasks in the plan are complete (done or failed).
 */
export function isPlanComplete(plan: TaskPlan, results: Map<string, TaskResult>): boolean {
  return plan.tasks.every((task) => {
    const result = results.get(task.id);
    return result?.status === "done" || result?.status === "failed" || result?.status === "skipped";
  });
}

/**
 * Formats a human-readable summary of plan progress.
 */
export function formatPlanProgress(plan: TaskPlan, results: Map<string, TaskResult>): string {
  const lines: string[] = [`Plan: ${plan.goal}`, ""];
  for (const task of plan.tasks) {
    const result = results.get(task.id);
    const status = result?.status ?? "pending";
    const icon =
      status === "done" ? "✓" :
      status === "failed" ? "✗" :
      status === "running" ? "→" :
      status === "skipped" ? "~" :
      "○";
    lines.push(`  ${icon} [${task.label}] ${task.description.slice(0, 60)}`);
  }
  return lines.join("\n");
}
