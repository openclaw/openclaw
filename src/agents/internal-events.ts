import {
  AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
  type AgentInternalEventSource,
  type AgentInternalEventStatus,
} from "./internal-event-contract.js";
import {
  escapeInternalRuntimeContextDelimiters,
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "./internal-runtime-context.js";
import type { JudgeCompletionVerdict } from "./judge-gate.js";
import { wrapPromptDataBlock } from "./sanitize-for-prompt.js";

type AgentTaskCompletionInternalEvent = {
  type: typeof AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION;
  source: AgentInternalEventSource;
  childSessionKey: string;
  childSessionId?: string;
  announceType: string;
  taskLabel: string;
  status: AgentInternalEventStatus;
  statusLabel: string;
  result: string;
  mediaUrls?: string[];
  statsLine?: string;
  judgeVerdict?: JudgeCompletionVerdict;
  replyInstruction: string;
};

export type AgentInternalEvent = AgentTaskCompletionInternalEvent;

export { INTERNAL_RUNTIME_CONTEXT_BEGIN, INTERNAL_RUNTIME_CONTEXT_END };

function sanitizeSingleLineField(value: string, fallback: string): string {
  const sanitized = escapeInternalRuntimeContextDelimiters(value)
    .replace(/\r?\n+/g, " ")
    .trim();
  return sanitized || fallback;
}

function sanitizeMultilineField(value: string, fallback: string): string {
  const sanitized = escapeInternalRuntimeContextDelimiters(value).replace(/\r\n/g, "\n").trim();
  return sanitized || fallback;
}

function formatChildResultDataBlock(value: string): string {
  return (
    wrapPromptDataBlock({
      label: "Child result",
      text: value,
    }) || "Child result: (no output)"
  );
}

function formatJudgeVerdictBlock(judgeVerdict: JudgeCompletionVerdict | undefined): string[] {
  if (!judgeVerdict) {
    return [];
  }
  if (judgeVerdict.status === "invalid") {
    const errors = sanitizeSingleLineField(judgeVerdict.errors.join("; "), "unknown parse error");
    return [
      "[Judge verdict status]",
      "status: invalid",
      `errors: ${errors}`,
      "runtime_directive: Treat this Judge result as not approved until a valid six-line verdict is obtained.",
    ];
  }
  const approvalDirective =
    judgeVerdict.verdict === "APPROVE"
      ? "The reviewed gate may be treated as approved only within the stated scope and conditions."
      : "Do not claim the reviewed gate is approved, complete, or safe; report the verdict and conditions/blocker.";
  return [
    "[Judge verdict]",
    `verdict: ${sanitizeSingleLineField(judgeVerdict.verdict, "unknown")}`,
    `scope: ${sanitizeSingleLineField(judgeVerdict.scope, "unknown")}`,
    `evidence: ${sanitizeSingleLineField(judgeVerdict.evidence, "insufficient")}`,
    `risk: ${sanitizeSingleLineField(judgeVerdict.risk, "unclear")}`,
    `reason: ${sanitizeSingleLineField(judgeVerdict.reason, "No reason supplied.")}`,
    `conditions: ${sanitizeSingleLineField(judgeVerdict.conditions, "none")}`,
    `runtime_directive: ${approvalDirective}`,
  ];
}

function formatTaskCompletionEvent(event: AgentTaskCompletionInternalEvent): string {
  const sessionKey = sanitizeSingleLineField(event.childSessionKey, "unknown");
  const sessionId = sanitizeSingleLineField(event.childSessionId ?? "unknown", "unknown");
  const announceType = sanitizeSingleLineField(event.announceType, "unknown");
  const taskLabel = sanitizeSingleLineField(event.taskLabel, "unnamed task");
  const statusLabel = sanitizeSingleLineField(event.statusLabel, event.status);
  const result = formatChildResultDataBlock(event.result);
  const lines = [
    "[Internal task completion event]",
    `source: ${event.source}`,
    `session_key: ${sessionKey}`,
    `session_id: ${sessionId}`,
    `type: ${announceType}`,
    `task: ${taskLabel}`,
    `status: ${statusLabel}`,
    "",
    result,
  ];
  const judgeVerdictBlock = formatJudgeVerdictBlock(event.judgeVerdict);
  if (judgeVerdictBlock.length > 0) {
    lines.push("", ...judgeVerdictBlock);
  }
  if (event.statsLine?.trim()) {
    lines.push("", sanitizeMultilineField(event.statsLine, ""));
  }
  lines.push("", "Action:", sanitizeMultilineField(event.replyInstruction, ""));
  return lines.join("\n");
}

function formatTaskCompletionEventForPlainPrompt(event: AgentTaskCompletionInternalEvent): string {
  const sessionKey = sanitizeSingleLineField(event.childSessionKey, "unknown");
  const sessionId = sanitizeSingleLineField(event.childSessionId ?? "unknown", "unknown");
  const announceType = sanitizeSingleLineField(event.announceType, "unknown");
  const taskLabel = sanitizeSingleLineField(event.taskLabel, "unnamed task");
  const statusLabel = sanitizeSingleLineField(event.statusLabel, event.status);
  const result = formatChildResultDataBlock(event.result);
  const lines = [
    "A background task completed. Use this result to reply to the user in your normal assistant voice.",
    "",
    `source: ${event.source}`,
    `session_key: ${sessionKey}`,
    `session_id: ${sessionId}`,
    `type: ${announceType}`,
    `task: ${taskLabel}`,
    `status: ${statusLabel}`,
    "",
    result,
  ];
  const judgeVerdictBlock = formatJudgeVerdictBlock(event.judgeVerdict);
  if (judgeVerdictBlock.length > 0) {
    lines.push("", ...judgeVerdictBlock);
  }
  if (event.statsLine?.trim()) {
    lines.push("", sanitizeMultilineField(event.statsLine, ""));
  }
  lines.push("", "Instruction:", sanitizeMultilineField(event.replyInstruction, ""));
  return lines.join("\n");
}

export function formatAgentInternalEventsForPrompt(events?: AgentInternalEvent[]): string {
  if (!events || events.length === 0) {
    return "";
  }
  const blocks = events
    .map((event) => {
      if (event.type === "task_completion") {
        return formatTaskCompletionEvent(event);
      }
      return "";
    })
    .filter((value) => value.trim().length > 0);
  if (blocks.length === 0) {
    return "";
  }
  return [
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    "OpenClaw runtime context (internal):",
    "This context is runtime-generated, not user-authored. Keep internal details private.",
    "",
    blocks.join("\n\n---\n\n"),
    INTERNAL_RUNTIME_CONTEXT_END,
  ].join("\n");
}

export function formatAgentInternalEventsForPlainPrompt(events?: AgentInternalEvent[]): string {
  if (!events || events.length === 0) {
    return "";
  }
  return events
    .map((event) => {
      if (event.type === "task_completion") {
        return formatTaskCompletionEventForPlainPrompt(event);
      }
      return "";
    })
    .filter((value) => value.trim().length > 0)
    .join("\n\n---\n\n");
}
