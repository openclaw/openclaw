/**
 * Lightweight task state tracking for OpenClaw agents.
 *
 * Provides a minimal runtime model for multi-step tasks: goal, status,
 * completed/pending steps, blockers, and sources. Designed to survive
 * context compaction by being serializable and self-contained.
 *
 * Learned from: Claude Code compact.rs / session.rs patterns and the
 * doc's task dispatch model (Section 6 & 11).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentTaskStatus =
  | "pending"
  | "running"
  | "waiting_for_user"
  | "blocked"
  | "completed"
  | "failed";

export type AgentTaskState = {
  /** Unique task id — callers may use any stable string (uuid, slug, etc.). */
  task_id: string;
  /** Human-readable title for the task. */
  title: string;
  /** The concrete goal the agent is working toward. */
  goal: string;
  status: AgentTaskStatus;
  /** Who owns execution: the main agent, a subagent, or a tool. */
  owner: "main_agent" | "subagent" | "tool";
  /** Steps already completed (order-preserving). */
  completed_steps: string[];
  /** Steps still to be done (order-preserving). */
  pending_steps: string[];
  /** Active blockers preventing forward progress. */
  blockers: string[];
  /** Provenance references gathered so far. */
  sources: string[];
  /** Arbitrary key/value inputs passed in when the task was created. */
  inputs: Record<string, unknown>;
  /** Outputs produced so far (partial ok). */
  outputs: Record<string, unknown>;
  /** ISO 8601 timestamp of creation. */
  created_at: string;
  /** ISO 8601 timestamp of last update. */
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Create a new task in `pending` state. */
export function createTaskState(params: {
  task_id: string;
  title: string;
  goal: string;
  owner?: AgentTaskState["owner"];
  pending_steps?: string[];
  inputs?: Record<string, unknown>;
}): AgentTaskState {
  const now = new Date().toISOString();
  return {
    task_id: params.task_id,
    title: params.title,
    goal: params.goal,
    status: "pending",
    owner: params.owner ?? "main_agent",
    completed_steps: [],
    pending_steps: params.pending_steps ?? [],
    blockers: [],
    sources: [],
    inputs: params.inputs ?? {},
    outputs: {},
    created_at: now,
    updated_at: now,
  };
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** Mark the task as running and record the timestamp. */
export function startTask(task: AgentTaskState): AgentTaskState {
  return { ...task, status: "running", updated_at: new Date().toISOString() };
}

/**
 * Advance the task by completing its first pending step.
 * If there are no more pending steps the task status stays `running`;
 * callers must explicitly call `completeTask` when the goal is met.
 */
export function advanceTaskStep(task: AgentTaskState, step?: string): AgentTaskState {
  const resolvedStep = step ?? task.pending_steps[0];
  if (!resolvedStep) {
    return task;
  }
  const pending = task.pending_steps.filter((s) => s !== resolvedStep);
  return {
    ...task,
    completed_steps: [...task.completed_steps, resolvedStep],
    pending_steps: pending,
    updated_at: new Date().toISOString(),
  };
}

/** Add a blocker preventing forward progress. */
export function blockTask(task: AgentTaskState, blocker: string): AgentTaskState {
  return {
    ...task,
    status: "blocked",
    blockers: [...task.blockers, blocker],
    updated_at: new Date().toISOString(),
  };
}

/** Clear a specific blocker (or all blockers if omitted). */
export function unblockTask(task: AgentTaskState, resolvedBlocker?: string): AgentTaskState {
  const blockers = resolvedBlocker ? task.blockers.filter((b) => b !== resolvedBlocker) : [];
  return {
    ...task,
    status: blockers.length === 0 ? "running" : "blocked",
    blockers,
    updated_at: new Date().toISOString(),
  };
}

/** Merge outputs into the task record. */
export function recordTaskOutputs(
  task: AgentTaskState,
  outputs: Record<string, unknown>,
): AgentTaskState {
  return {
    ...task,
    outputs: { ...task.outputs, ...outputs },
    updated_at: new Date().toISOString(),
  };
}

/** Append provenance sources to the task. */
export function addTaskSources(task: AgentTaskState, sources: string[]): AgentTaskState {
  const unique = [...new Set([...task.sources, ...sources])];
  return { ...task, sources: unique, updated_at: new Date().toISOString() };
}

/** Mark the task as successfully completed. */
export function completeTask(task: AgentTaskState): AgentTaskState {
  return {
    ...task,
    status: "completed",
    pending_steps: [],
    updated_at: new Date().toISOString(),
  };
}

/** Mark the task as failed with an optional reason appended to blockers. */
export function failTask(task: AgentTaskState, reason?: string): AgentTaskState {
  return {
    ...task,
    status: "failed",
    blockers: reason ? [...task.blockers, reason] : task.blockers,
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** True when the task has reached a terminal state. */
export function isTaskTerminal(task: AgentTaskState): boolean {
  return task.status === "completed" || task.status === "failed";
}

/**
 * Render a compact one-paragraph status summary for inclusion in a prompt or
 * compaction resume block. Keeps the model oriented without wasting tokens.
 */
export function renderTaskSummary(task: AgentTaskState): string {
  const lines: string[] = [`Task: ${task.title} [${task.status}]`, `Goal: ${task.goal}`];
  if (task.completed_steps.length > 0) {
    lines.push(`Done: ${task.completed_steps.join(", ")}`);
  }
  if (task.pending_steps.length > 0) {
    lines.push(`Next: ${task.pending_steps.join(", ")}`);
  }
  if (task.blockers.length > 0) {
    lines.push(`Blocked: ${task.blockers.join("; ")}`);
  }
  if (task.sources.length > 0) {
    lines.push(`Sources: ${task.sources.join(", ")}`);
  }
  return lines.join("\n");
}
