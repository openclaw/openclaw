/**
 * Memory write judgment for OpenClaw agents.
 *
 * Provides a decision helper that agents should invoke at the end of each task
 * to decide whether — and what — to persist to long-term memory. This does NOT
 * replace the existing plugin-hook memory system; it adds an explicit judgment
 * layer on top of it.
 *
 * Learned from: Claude Code session.rs patterns and the doc's Section 8.
 */

import type { AgentTaskState } from "./agent-task-state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Signals from the conversation that inform the memory judgment. */
export type MemoryJudgmentInput = {
  /** The task that just finished (or the in-progress task at compaction). */
  task: AgentTaskState;
  /** Whether the user explicitly asked to remember or save this workflow. */
  userRequestedMemory?: boolean;
  /** Whether a new reusable workflow or procedure was established. */
  hasReusableWorkflow?: boolean;
  /** Whether a user preference was discovered or confirmed. */
  hasUserPreference?: boolean;
  /** Whether there are pending follow-up actions the user will want later. */
  hasPendingFollowUp?: boolean;
  /** Whether a significant project state change occurred. */
  hasProjectStateChange?: boolean;
  /**
   * Whether the task involved sensitive credentials, PII, or private data.
   * True forces `write: false` regardless of other signals.
   */
  involvesSensitiveData?: boolean;
  /** Whether the task ran inside a group/public channel context. */
  isGroupContext?: boolean;
};

export type MemoryType = "long_term" | "project" | "short_term";

export type MemoryJudgmentResult = {
  /** Whether anything should be written to memory. */
  write: boolean;
  /** Which memory tier to target. */
  type: MemoryType;
  /** Human-readable rationale for the decision. */
  reason: string;
  /**
   * Suggested markdown entry body using the doc's canonical format.
   * Only populated when `write` is true.
   */
  suggested_entry?: string;
};

// ---------------------------------------------------------------------------
// Judgment
// ---------------------------------------------------------------------------

/**
 * Decide whether to write to memory after a task completes.
 *
 * Rules (in priority order):
 * 1. Never write if sensitive data is involved.
 * 2. Always write long_term if the user explicitly asked.
 * 3. Write long_term for reusable workflows / user preferences.
 * 4. Write project for pending follow-up or significant project state change.
 * 5. Never write just because a task ran — require at least one positive signal.
 */
export function judgeMemoryWrite(input: MemoryJudgmentInput): MemoryJudgmentResult {
  // Safety guard: never write sensitive data.
  if (input.involvesSensitiveData) {
    return {
      write: false,
      type: "short_term",
      reason: "Task involved sensitive data — not persisting to memory.",
    };
  }

  // Safety guard: never expose private memory into group contexts.
  if (input.isGroupContext && (input.hasUserPreference || input.userRequestedMemory)) {
    return {
      write: false,
      type: "short_term",
      reason: "Group context — skipping personal memory write to avoid exposure.",
    };
  }

  // Explicit user request → long-term.
  if (input.userRequestedMemory) {
    return {
      write: true,
      type: "long_term",
      reason: "User explicitly requested this to be remembered.",
      suggested_entry: buildMemoryEntry(input.task, "long_term"),
    };
  }

  // Reusable workflow or stable user preference → long-term.
  if (input.hasReusableWorkflow || input.hasUserPreference) {
    return {
      write: true,
      type: "long_term",
      reason: input.hasReusableWorkflow
        ? "A reusable workflow was established."
        : "A user preference was discovered.",
      suggested_entry: buildMemoryEntry(input.task, "long_term"),
    };
  }

  // Pending follow-ups or project state change → project memory.
  if (input.hasPendingFollowUp || input.hasProjectStateChange) {
    return {
      write: true,
      type: "project",
      reason: input.hasPendingFollowUp
        ? "There are pending follow-up actions."
        : "A project state change occurred.",
      suggested_entry: buildMemoryEntry(input.task, "project"),
    };
  }

  // No strong signal — skip.
  return {
    write: false,
    type: "short_term",
    reason: "No signal strong enough to warrant persistent memory write.",
  };
}

// ---------------------------------------------------------------------------
// Entry builder
// ---------------------------------------------------------------------------

/**
 * Build a markdown memory entry using the canonical format from the doc:
 *
 * ## YYYY-MM-DD - 主题
 * - 背景：
 * - 结论：
 * - 已完成：
 * - 待跟进：
 * - 相关来源：
 */
export function buildMemoryEntry(task: AgentTaskState, type: MemoryType): string {
  const date = new Date().toISOString().split("T")[0];
  const lines: string[] = [`## ${date} - ${task.title}`];

  lines.push(`- 背景：${task.goal}`);

  const conclusion =
    task.status === "completed"
      ? `任务已完成。产出：${JSON.stringify(task.outputs)}`
      : `任务状态：${task.status}。`;
  lines.push(`- 结论：${conclusion}`);

  if (task.completed_steps.length > 0) {
    lines.push(`- 已完成：${task.completed_steps.join("；")}`);
  }

  if (task.pending_steps.length > 0) {
    lines.push(`- 待跟进：${task.pending_steps.join("；")}`);
  } else {
    lines.push("- 待跟进：无");
  }

  if (task.sources.length > 0) {
    lines.push(`- 相关来源：${task.sources.join(", ")}`);
  } else {
    lines.push("- 相关来源：无");
  }

  if (type === "long_term") {
    lines.push("<!-- 长期记忆 -->");
  } else if (type === "project") {
    lines.push("<!-- 项目记忆 -->");
  }

  return lines.join("\n");
}
