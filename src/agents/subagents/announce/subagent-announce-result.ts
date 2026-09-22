/** Exact-run final answer reads for subagent completion announcements. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import {
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../../../sessions/transcript-events.js";
import type { AgentRunSessionTarget } from "../../run-session-target.js";
import { wrapPromptDataBlock } from "../../sanitize-for-prompt.js";
import { extractStoredAssistantText } from "../../tools/chat-history-text.js";
import { resolveSubagentCompletionResultText } from "../completion/subagent-completion-result.js";
import {
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "../registry/subagent-lifecycle-events.js";

const MAX_CHILD_COMPLETION_FIELD_CHARS = 256;

type OutputRuntime = typeof import("./subagent-announce.runtime.js");
type SubagentAnnounceResultDeps = Pick<
  OutputRuntime,
  | "getRuntimeConfig"
  | "readSubagentSessionEntry"
  | "resolveAgentIdFromSessionKey"
  | "resolveSessionStorePathCore"
> & {
  findTranscriptEvent: typeof import("../../../config/sessions/session-accessor.js").findTranscriptEvent;
  findSessionTranscriptArchiveEventReadOnly: typeof import("../../../config/sessions/session-history.js").findSessionTranscriptArchiveEventReadOnly;
};

type AnnounceChild = Pick<ChildCompletionRow, "childSessionKey" | "execution" | "completion"> & {
  runId: string;
};
export type PreparedAnnounceResult = { text: string | undefined; isCurrent: () => boolean };

function captureAnnounceResultAuthority(child: AnnounceChild): () => boolean {
  const { runId, childSessionKey } = child;
  const terminalReply = child.completion?.terminalReply;
  const outcome = child.execution.outcome;
  const target = child.execution.transcriptTarget;
  const targetIdentity = target ? { ...target } : undefined;
  return () => {
    const currentTarget = child.execution.transcriptTarget;
    return (
      child.runId === runId &&
      child.childSessionKey === childSessionKey &&
      child.completion?.terminalReply === terminalReply &&
      child.execution.outcome === outcome &&
      currentTarget === target &&
      currentTarget?.sessionId === targetIdentity?.sessionId &&
      currentTarget?.agentId === targetIdentity?.agentId &&
      currentTarget?.storePath === targetIdentity?.storePath
    );
  };
}

export function isVisibleSubagentResultEventForRun(event: unknown, runId: string): boolean {
  if (
    !isRecord(event) ||
    !isRecord(event.message) ||
    readSessionTranscriptRunId(event.message) !== runId ||
    resolveTerminalAssistantTranscriptRunId(event.message, runId) === undefined
  ) {
    return false;
  }
  const mirror = event.message.openclawDeliveryMirror;
  if (isRecord(mirror) && mirror.kind === "message-tool-source-reply" && mirror.final !== true) {
    return false;
  }
  // A final source reply remains visible when the run ends with NO_REPLY.
  const text = extractStoredAssistantText(event.message);
  return Boolean(text?.trim()) && !isSilentReplyText(text, SILENT_REPLY_TOKEN);
}

/** Read the final assistant message from the transcript identity owned by this run. */
export async function readSubagentRunAnnounceResultUsing(
  child: AnnounceChild,
  deps: SubagentAnnounceResultDeps,
): Promise<PreparedAnnounceResult> {
  const isCurrent = captureAnnounceResultAuthority(child);
  const terminalReply = child.completion?.terminalReply;
  if (terminalReply?.disposition !== "visible" || child.execution.outcome?.status !== "ok") {
    return { text: resolveSubagentCompletionResultText(child), isCurrent };
  }
  const runId = child.runId;
  const childSessionKey = child.childSessionKey;
  const target = child.execution.transcriptTarget;
  const agentId = target?.agentId ?? deps.resolveAgentIdFromSessionKey(childSessionKey);
  const storePath =
    target?.storePath ??
    deps.resolveSessionStorePathCore(deps.getRuntimeConfig().session?.store, { agentId });
  const sessionKey = target?.sessionKey ?? childSessionKey;
  const sessionId =
    target?.sessionId ?? deps.readSubagentSessionEntry(storePath, sessionKey)?.sessionId;
  const scope = { agentId, storePath, sessionKey };
  const matchesRun = (event: unknown) => isVisibleSubagentResultEventForRun(event, runId);
  const found = sessionId
    ? await deps.findTranscriptEvent({ ...scope, sessionId }, matchesRun)
    : undefined;
  let event: unknown = found?.event;
  if (!event) {
    // Delete commits the canonical archive before its derived file is published.
    event = (await deps.findSessionTranscriptArchiveEventReadOnly({ ...scope, sessionId }, runId))
      ?.event;
  }
  if (!isCurrent()) {
    throw new Error("The completed child run's transcript identity changed during announcement.");
  }
  const answer = isRecord(event) ? extractStoredAssistantText(event.message) : undefined;
  if (!answer) {
    return {
      text: `[truncated-by-retention: complete child answer unavailable]\n${terminalReply.text}`,
      isCurrent,
    };
  }
  return { text: answer, isCurrent };
}

function describeSubagentOutcome(child: ChildCompletionRow): string {
  const outcome = child.execution.outcome;
  if (child.endedReason === SUBAGENT_ENDED_REASON_KILLED) {
    const error = outcome?.error?.trim();
    return error ? `cancelled: ${error}` : "cancelled";
  }
  if (!outcome) {
    return "unknown";
  }
  if (outcome.status === "ok") {
    return "ok";
  }
  if (outcome.status === "timeout" || outcome.status === "error") {
    const error = outcome.error?.trim();
    return error ? `${outcome.status}: ${error}` : outcome.status;
  }
  return "unknown";
}

function formatChildResultData(resultText?: string | null): string {
  return (
    wrapPromptDataBlock({
      label: "Child result",
      text: resultText?.trim() || "(no output)",
    }) || "Child result: (no output)"
  );
}

function truncateChildCompletionField(value: string): string {
  return value.length > MAX_CHILD_COMPLETION_FIELD_CHARS
    ? `${truncateUtf16Safe(value, MAX_CHILD_COMPLETION_FIELD_CHARS - 1)}…`
    : value;
}

type CompletionResultSource = Parameters<typeof resolveSubagentCompletionResultText>[0];
type ChildCompletionExecution = CompletionResultSource["execution"] & {
  endedAt?: number;
  outcome?: NonNullable<CompletionResultSource["execution"]["outcome"]> & { error?: string };
  transcriptTarget?: AgentRunSessionTarget;
};

export type ChildCompletionRow = {
  announceResult?: string;
  childSessionKey: string;
  task: string;
  taskName?: string;
  label?: string;
  createdAt: number;
  execution: ChildCompletionExecution;
  endedReason?: SubagentLifecycleEndedReason;
  completion?: Parameters<typeof resolveSubagentCompletionResultText>[0]["completion"];
};

function hasCapturedChildCompletionReply(child: ChildCompletionRow): boolean {
  return Boolean(
    child.completion?.terminalReply ||
    child.completion?.resultText?.trim() ||
    child.completion?.fallbackResultText?.trim(),
  );
}

export function buildChildCompletionFindings(
  children: Array<ChildCompletionRow>,
): string | undefined {
  const sorted = [...children].toSorted((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    const aEnded =
      typeof a.execution.endedAt === "number" ? a.execution.endedAt : Number.MAX_SAFE_INTEGER;
    const bEnded =
      typeof b.execution.endedAt === "number" ? b.execution.endedAt : Number.MAX_SAFE_INTEGER;
    if (aEnded !== bEnded) {
      return aEnded - bEnded;
    }
    // Parallel children commonly share millisecond timestamps; their stable
    // session identity keeps parent-visible findings and prompt bytes ordered.
    return a.childSessionKey < b.childSessionKey
      ? -1
      : a.childSessionKey > b.childSessionKey
        ? 1
        : 0;
  });

  const sections: string[] = [];
  for (const [index, child] of sorted.entries()) {
    const resultText = child.announceResult ?? resolveSubagentCompletionResultText(child);
    const outcome = describeSubagentOutcome(child);
    if (
      child.execution.outcome?.status === "ok" &&
      !resultText &&
      hasCapturedChildCompletionReply(child)
    ) {
      continue;
    }
    const title =
      child.taskName?.trim() ||
      child.label?.trim() ||
      child.task.trim() ||
      child.childSessionKey.trim() ||
      `child ${index + 1}`;
    const displayIndex = sections.length + 1;
    sections.push(
      [
        wrapPromptDataBlock({
          label: `${displayIndex}. Child task`,
          text: title,
          maxEscapedChars: MAX_CHILD_COMPLETION_FIELD_CHARS,
          truncationMarker: "…",
        }),
        `status: ${truncateChildCompletionField(outcome)}`,
        formatChildResultData(resultText),
      ].join("\n"),
    );
  }

  if (sections.length === 0) {
    return undefined;
  }

  return ["Child completion results:", "", ...sections].join("\n\n");
}
