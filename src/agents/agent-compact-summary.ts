/**
 * Structured compaction summary helpers for OpenClaw agents.
 *
 * When context overflows, the agent needs to compact the conversation. After
 * compaction the model must be able to resume without re-running tools. This
 * module provides the canonical summary format and a continuation prompt
 * generator that preserves all fields the doc requires.
 *
 * Learned from: Claude Code compact.rs (format_compact_summary,
 * get_compact_continuation_message) and the doc's Section 9.
 */

import type { AgentTaskState } from "./agent-task-state.js";
import { renderTaskSummary } from "./agent-task-state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The structured fields that a compaction summary must carry so the agent can
 * resume without information loss.
 */
export type CompactSummaryFields = {
  /** What the user originally asked for. */
  user_goal: string;
  /** Current execution status of the primary task. */
  current_status: string;
  /** Steps already finished before compaction. */
  completed_steps: string[];
  /** Tools invoked so far and their key outcomes. */
  tools_used: Array<{ tool: string; summary: string }>;
  /** The most important facts/findings collected. */
  key_findings: string[];
  /** Provenance references (URLs, file paths, API names). */
  sources: string[];
  /** Steps still to be done after resuming. */
  pending_steps: string[];
  /** Active blockers the agent must resolve. */
  blockers: string[];
  /** Recommended next action to take on resume. */
  next_step: string;
  /** Hard constraints or preferences the user stated. */
  user_constraints: string[];
};

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Build a CompactSummaryFields object from an AgentTaskState plus any extra
 * metadata gathered during the run.
 */
export function buildCompactSummaryFromTask(
  task: AgentTaskState,
  extra?: Partial<
    Pick<CompactSummaryFields, "tools_used" | "key_findings" | "next_step" | "user_constraints">
  >,
): CompactSummaryFields {
  return {
    user_goal: task.goal,
    current_status: task.status,
    completed_steps: task.completed_steps,
    tools_used: extra?.tools_used ?? [],
    key_findings: extra?.key_findings ?? [],
    sources: task.sources,
    pending_steps: task.pending_steps,
    blockers: task.blockers,
    next_step: extra?.next_step ?? task.pending_steps[0] ?? "No pending steps.",
    user_constraints: extra?.user_constraints ?? [],
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Format a CompactSummaryFields into the canonical XML-style block the model
 * receives after compaction. Mirrors Claude Code's `format_compact_summary`
 * and aligns with the doc's Section 9 format.
 */
export function formatCompactSummary(fields: CompactSummaryFields): string {
  const lines: string[] = ["<summary>"];

  lines.push(`用户目标: ${fields.user_goal}`);
  lines.push(`当前状态: ${fields.current_status}`);

  if (fields.completed_steps.length > 0) {
    lines.push(`已完成:`);
    for (const step of fields.completed_steps) {
      lines.push(`  - ${step}`);
    }
  }

  if (fields.tools_used.length > 0) {
    lines.push(`已调用工具:`);
    for (const { tool, summary } of fields.tools_used) {
      lines.push(`  - ${tool}: ${summary}`);
    }
  }

  if (fields.key_findings.length > 0) {
    lines.push(`关键发现:`);
    for (const finding of fields.key_findings) {
      lines.push(`  - ${finding}`);
    }
  }

  if (fields.sources.length > 0) {
    lines.push(`来源: ${fields.sources.join(", ")}`);
  }

  if (fields.pending_steps.length > 0) {
    lines.push(`未完成:`);
    for (const step of fields.pending_steps) {
      lines.push(`  - ${step}`);
    }
  }

  if (fields.blockers.length > 0) {
    lines.push(`阻塞:`);
    for (const blocker of fields.blockers) {
      lines.push(`  - ${blocker}`);
    }
  }

  lines.push(`下一步: ${fields.next_step}`);

  if (fields.user_constraints.length > 0) {
    lines.push(`用户约束:`);
    for (const constraint of fields.user_constraints) {
      lines.push(`  - ${constraint}`);
    }
  }

  lines.push("</summary>");
  return lines.join("\n");
}

/**
 * Generate the continuation message that is injected as the first assistant
 * turn after compaction. Mirrors Claude Code's `get_compact_continuation_message`.
 */
export function getCompactContinuationMessage(params: {
  summary: string;
  hasRecentMessages: boolean;
  suppressFollowUpQuestions?: boolean;
}): string {
  let message =
    "本次对话从之前一次超出上下文限制的会话继续。以下摘要覆盖了较早的部分。\n\n" + params.summary;

  if (params.hasRecentMessages) {
    message += "\n\n最近的消息已完整保留。";
  }

  if (params.suppressFollowUpQuestions ?? true) {
    message += "\n从中断处继续，不要询问用户任何问题，不要重述摘要，直接恢复执行。";
  }

  return message;
}

/**
 * Convenience: build the full continuation message from an AgentTaskState
 * and optional extra fields, returning the formatted string ready to be
 * injected into the compacted session.
 */
export function buildCompactContinuationFromTask(
  task: AgentTaskState,
  extra?: {
    tools_used?: Array<{ tool: string; summary: string }>;
    key_findings?: string[];
    next_step?: string;
    user_constraints?: string[];
    hasRecentMessages?: boolean;
  },
): string {
  const fields = buildCompactSummaryFromTask(task, extra);
  const summaryText = formatCompactSummary(fields);
  return getCompactContinuationMessage({
    summary: summaryText,
    hasRecentMessages: extra?.hasRecentMessages ?? false,
  });
}

/**
 * Render a compact one-line status for use in the heartbeat or progress
 * messages when the agent is mid-task.
 */
export function renderMidTaskProgressLine(task: AgentTaskState): string {
  const done = task.completed_steps.length;
  const total = done + task.pending_steps.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return `[${task.status}] ${task.title} — ${pct}% (${done}/${total} steps)`;
}

// Re-export for convenience so callers only need one import for task rendering.
export { renderTaskSummary };
