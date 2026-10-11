import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { truncateUtf16WithEllipsis } from "../../../shared/text-truncate.js";
import { wrapPromptDataBlock } from "../../sanitize-for-prompt.js";
import { extractStoredAssistantText } from "../../tools/chat-history-text.js";
import { resolveSubagentCompletionResultText } from "../completion/subagent-completion-result.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "../registry/subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { isSameSubagentRunOwner } from "../registry/subagent-run-generation.js";
import { withSubagentSessionSource } from "../spawn/subagent-session-source.js";

const MAX_CHILD_COMPLETION_FIELD_CHARS = 256;

type OutputRuntime = typeof import("./subagent-announce.runtime.js");
type SubagentAnnounceResultDeps = Pick<
  OutputRuntime,
  | "getRuntimeConfig"
  | "readSubagentSessionEntry"
  | "resolveAgentIdFromSessionKey"
  | "resolveSessionStorePathCore"
> & {
  readSubagentRun: (runId: string) => SubagentRunRecord | undefined;
  findTranscriptEvent: typeof import("../../../config/sessions/session-accessor.js").findTranscriptEvent;
  findSessionTranscriptArchiveEventReadOnly: typeof import("../../../config/sessions/session-history.js").findSessionTranscriptArchiveEventReadOnly;
};

export type PreparedAnnounceResult = { text: string | undefined; isCurrent: () => boolean };

export class SubagentAnnouncePreparationConflictError extends Error {
  override name = "SubagentAnnouncePreparationConflictError";
}

function announceResultFacts(child: SubagentRunRecord) {
  return {
    task: child.task,
    taskName: child.taskName,
    label: child.label,
    endedReason: child.endedReason,
    status: child.execution.status,
    endedAt: child.execution.endedAt,
    outcome: child.execution.outcome,
    interruptionReason: child.execution.interruptionReason,
    transcriptTarget: child.execution.transcriptTarget,
    terminalReply: child.completion?.terminalReply,
    resultText: child.completion?.resultText,
    fallbackResultText: child.completion?.fallbackResultText,
  };
}

function captureAnnounceResultAuthority(
  child: SubagentRunRecord,
  readSubagentRun: SubagentAnnounceResultDeps["readSubagentRun"],
): () => boolean {
  const facts = structuredClone(announceResultFacts(child));
  const runId = child.runId;
  return () => {
    const current = readSubagentRun(runId);
    return Boolean(
      current &&
      isSameSubagentRunOwner(current, child) &&
      isDeepStrictEqual(announceResultFacts(current), facts),
    );
  };
}

/** Read the final assistant message from the transcript identity owned by this run. */
export async function readSubagentRunAnnounceResultUsing(
  observed: SubagentRunRecord,
  deps: SubagentAnnounceResultDeps,
): Promise<PreparedAnnounceResult> {
  const child = deps.readSubagentRun(observed.runId);
  if (!child || !isSameSubagentRunOwner(child, observed)) {
    throw new SubagentAnnouncePreparationConflictError(
      "The completed child run's owner changed before announcement.",
    );
  }
  const isCurrent = captureAnnounceResultAuthority(child, deps.readSubagentRun);
  const terminalReply = child.completion?.terminalReply;
  const capturedResult = resolveSubagentCompletionResultText(child);
  if (
    !capturedResult ||
    terminalReply?.disposition !== "visible" ||
    child.execution.outcome?.status !== "ok"
  ) {
    return { text: capturedResult, isCurrent };
  }
  const runId = child.runId;
  const childSessionKey = child.childSessionKey;
  const target = child.execution.transcriptTarget;
  const agentId = target?.agentId ?? deps.resolveAgentIdFromSessionKey(childSessionKey);
  const storePath =
    target?.storePath ??
    deps.resolveSessionStorePathCore(deps.getRuntimeConfig().session?.store, { agentId });
  const sessionKey = target?.sessionKey ?? childSessionKey;
  return withSubagentSessionSource({ agentId, storePath, sessionKey }, async (source) => {
    const sourcePath = source?.path ?? storePath;
    const sessionId =
      target?.sessionId ??
      (await deps.readSubagentSessionEntry(sourcePath, sessionKey, agentId))?.sessionId;
    const scope = { agentId, storePath: sourcePath, sessionKey };
    const found =
      sessionId && (source || !isIncognitoSessionKey(sessionKey))
        ? await deps.findTranscriptEvent({ ...scope, sessionId }, { kind: "visible-final", runId })
        : undefined;
    let event: unknown = found?.event;
    if (!event && !isIncognitoSessionKey(sessionKey)) {
      // Delete commits the canonical archive before its derived file is published.
      event = (await deps.findSessionTranscriptArchiveEventReadOnly({ ...scope, sessionId }, runId))
        ?.event;
    }
    if (!isCurrent()) {
      throw new SubagentAnnouncePreparationConflictError(
        "The completed child run's transcript identity changed during announcement.",
      );
    }
    const answer = isRecord(event) ? extractStoredAssistantText(event.message) : undefined;
    if (!answer) {
      return {
        text: `[truncated-by-retention: complete child answer unavailable]\n${terminalReply.text}`,
        isCurrent,
      };
    }
    return { text: answer, isCurrent };
  });
}

function describeSubagentOutcome(child: ChildCompletionRow): string {
  const outcome = child.execution.outcome;
  if (child.endedReason === SUBAGENT_ENDED_REASON_KILLED) {
    const error = outcome?.error?.trim();
    return error ? `cancelled: ${error}` : "cancelled";
  }
  if (child.execution.interruptionReason === "gateway-restart") {
    return "interrupted by gateway restart";
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

export type ChildCompletionRow = Pick<
  SubagentRunRecord,
  "childSessionKey" | "task" | "taskName" | "label" | "createdAt" | "endedReason"
> & {
  announceResult?: string;
  execution: Pick<
    SubagentRunRecord["execution"],
    "endedAt" | "outcome" | "transcriptTarget" | "interruptionReason"
  >;
  completion?: Partial<
    Pick<
      NonNullable<SubagentRunRecord["completion"]>,
      "required" | "resultText" | "fallbackResultText" | "terminalReply"
    >
  >;
};

export function buildChildCompletionFindings(
  children: Array<ChildCompletionRow>,
): string | undefined {
  const sorted = children.toSorted((a, b) => {
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
      child.completion?.required !== true &&
      child.completion?.terminalReply?.disposition !== "empty" &&
      (child.completion?.terminalReply ||
        child.completion?.resultText?.trim() ||
        child.completion?.fallbackResultText?.trim())
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
        `status: ${truncateUtf16WithEllipsis(outcome, MAX_CHILD_COMPLETION_FIELD_CHARS)}`,
        wrapPromptDataBlock({
          label: "Child result",
          text: resultText?.trim() || "(no output)",
        }) || "Child result: (no output)",
      ].join("\n"),
    );
  }

  if (sections.length === 0) {
    return undefined;
  }

  return ["Child completion results:", "", ...sections].join("\n\n");
}
