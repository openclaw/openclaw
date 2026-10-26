import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { readTerminalSourceReplyDeliveryMirror } from "../../../shared/chat-message-content.js";
import { truncateUtf16WithEllipsis } from "../../../shared/text-truncate.js";
import {
  parseInlineDirectives,
  stripInlineDirectiveTagsForDelivery,
} from "../../../utils/directive-tags.js";
import { prepareTerminalAssistantReply } from "../../assistant-terminal-reply.js";
import { wrapPromptDataBlock } from "../../sanitize-for-prompt.js";
import { extractStoredAssistantText } from "../../tools/chat-history-text.js";
import { resolveSubagentCompletionResultText } from "../completion/subagent-completion-result.js";
import { resolveSubagentChildAgentId } from "../registry/subagent-child-owner-match.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "../registry/subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { isSameSubagentRunOwner } from "../registry/subagent-run-generation.js";
import { withSubagentSessionSource } from "../spawn/subagent-session-source.js";

const MAX_CHILD_COMPLETION_FIELD_CHARS = 256;
const MAX_CHILD_COMPLETION_FINDINGS_CHARS = 160_000;
const MIN_CHILD_COMPLETION_RESULT_CHARS = 64;

type OutputRuntime = typeof import("./subagent-announce.runtime.js");
type SubagentAnnounceResultDeps = Pick<
  OutputRuntime,
  "getRuntimeConfig" | "readSubagentSessionEntry" | "resolveSessionStorePathCore"
> & {
  readSubagentRun: (runId: string) => SubagentRunRecord | undefined;
  findTranscriptEvent: typeof import("../../../config/sessions/session-accessor.js").findTranscriptEvent;
  findSessionTranscriptArchiveEventReadOnly: typeof import("../../../config/sessions/session-history.js").findSessionTranscriptArchiveEventReadOnly;
};

export type PreparedAnnounceResult = { text: string | undefined; isCurrent: () => boolean };

type SubagentFinalAnswerDeps = Omit<SubagentAnnounceResultDeps, "readSubagentRun">;

export class SubagentAnnouncePreparationConflictError extends Error {
  override name = "SubagentAnnouncePreparationConflictError";
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
  // Terminal result metadata is best-effort; replacement executions still lose ownership.
  const isCurrent = () => {
    const current = deps.readSubagentRun(child.runId);
    return (
      isSameSubagentRunOwner(current, child) &&
      current?.endedReason === child.endedReason &&
      current?.execution.outcome?.status === child.execution.outcome?.status
    );
  };
  const terminalReply = child.completion?.terminalReply;
  const capturedResult = resolveSubagentCompletionResultText(child);
  if (
    !capturedResult ||
    terminalReply?.disposition !== "visible" ||
    child.execution.outcome?.status !== "ok"
  ) {
    return { text: capturedResult, isCurrent };
  }
  if (!resolveSubagentChildAgentId(child)) {
    return { text: capturedResult, isCurrent };
  }
  const answer = await readSubagentRunFinalAnswerUsing(child, deps, () => {
    if (!isCurrent()) {
      throw new SubagentAnnouncePreparationConflictError(
        "The completed child run's transcript identity changed during announcement.",
      );
    }
  });
  if (!answer) {
    return {
      text: `[truncated-by-retention: complete child answer unavailable]\n${terminalReply.text}`,
      isCurrent,
    };
  }
  return { text: answer, isCurrent };
}

/**
 * Read the complete visible final answer this exact run recorded, including an archived
 * transcript after delete-mode cleanup. The bounded lifecycle preview is not consulted.
 */
export async function readSubagentRunFinalAnswerUsing(
  child: SubagentRunRecord,
  deps: SubagentFinalAnswerDeps,
  assertCurrent?: () => void,
): Promise<string | undefined> {
  const runId = child.runId;
  const childAgentId = resolveSubagentChildAgentId(child);
  if (!childAgentId) {
    return undefined;
  }
  const target = child.execution.transcriptTarget;
  const agentId = target?.agentId ?? childAgentId;
  const storePath =
    target?.storePath ??
    deps.resolveSessionStorePathCore(deps.getRuntimeConfig().session?.store, { agentId });
  const sessionKey = target?.sessionKey ?? child.childSessionKey;
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
    assertCurrent?.();
    const message = isRecord(event) ? asOptionalObjectRecord(event.message) : undefined;
    // Explicit delivery records already own their display text, including literal NO_REPLY.
    // Parent review keeps media references as data rather than extracting channel attachments.
    const answer =
      message?.display === true || readTerminalSourceReplyDeliveryMirror(message)
        ? extractStoredAssistantText(message)
        : stripInlineDirectiveTagsForDelivery(
            parseInlineDirectives(
              prepareTerminalAssistantReply(
                message && {
                  content: typeof message.text === "string" ? message.text : message.content,
                  stopReason: message.stopReason,
                  phase: message.phase,
                },
              ).text,
            ).text,
          ).text;
    return answer || undefined;
  });
}

function describeSubagentOutcome(child: ChildCompletionRow): string {
  const outcome = child.execution.outcome;
  if (child.endedReason === SUBAGENT_ENDED_REASON_KILLED) {
    const error = outcome?.error?.trim();
    return error ? `cancelled: ${error}` : "cancelled";
  }
  if (child.execution.interruptionReason === "gateway-restart") {
    const error = outcome?.error?.trim();
    return error ? `interrupted by gateway restart: ${error}` : "interrupted by gateway restart";
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
    const aEnded = a.execution.endedAt ?? Number.MAX_SAFE_INTEGER;
    const bEnded = b.execution.endedAt ?? Number.MAX_SAFE_INTEGER;
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

  const resultFrameChars = wrapPromptDataBlock({ label: "Child result", text: "x" }).length - 1;
  const sections = [];
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
    const displayIndex: number = sections.length + 1;
    // Requesters may quote results verbatim, so keep the child's characters.
    const result = {
      label: "Child result",
      text: resultText?.trim() || "(no output)",
      encoding: "verbatim" as const,
      truncationMarker: `[result truncated; sessions_history sessionKey=${JSON.stringify(child.childSessionKey)} (text fields truncated to 4,000 characters)]`,
    };
    const resultBlock = wrapPromptDataBlock(result) || "Child result: (no output)";
    sections.push({
      result,
      childSessionKey: child.childSessionKey,
      resultBlock,
      minimumChars: (
        wrapPromptDataBlock({
          ...result,
          maxEscapedChars:
            wrapPromptDataBlock({ ...result, text: result.truncationMarker }).length -
            resultFrameChars +
            MIN_CHILD_COMPLETION_RESULT_CHARS,
        }) || resultBlock
      ).length,
      header: [
        wrapPromptDataBlock({
          label: `${displayIndex}. Child task`,
          text: title,
          maxEscapedChars: MAX_CHILD_COMPLETION_FIELD_CHARS,
          truncationMarker: "…",
        }),
        `status: ${truncateUtf16WithEllipsis(outcome, MAX_CHILD_COMPLETION_FIELD_CHARS)}`,
      ].join("\n"),
    });
  }

  if (sections.length === 0) {
    return undefined;
  }

  const heading = "Child completion results:\n\n";
  const available = MAX_CHILD_COMPLETION_FINDINGS_CHARS - heading.length;
  let minimumChars = sections.reduce(
    (total, section) => total + section.header.length + section.minimumChars + 3,
    0,
  );
  let included = sections.length;
  let summary = "";
  // Keep a stable prefix at the result-head floor, reserving the actual overflow line.
  for (const omitted of sections.toReversed()) {
    if (minimumChars + (summary ? summary.length + 2 : 0) <= available) {
      break;
    }
    included -= 1;
    minimumChars -= omitted.header.length + omitted.minimumChars + 3;
    const keys = wrapPromptDataBlock({
      label: "First child session keys",
      text: JSON.stringify(
        sections.slice(included, included + 3).map((row) => row.childSessionKey),
      ),
      maxEscapedChars: MAX_CHILD_COMPLETION_FIELD_CHARS,
      truncationMarker: "…",
    }).replaceAll("\n", " ");
    summary = `${sections.length - included} additional child results omitted; ${keys}. Inspect remaining children with the session tools available to you.`;
  }
  let remaining = available - minimumChars - (summary ? summary.length + 2 : 0);
  const visible = sections.slice(0, included);
  // Allocate small outstanding answers first, then share the rest above each child's floor.
  const bySize = visible.toSorted(
    (a, b) => a.resultBlock.length - a.minimumChars - (b.resultBlock.length - b.minimumChars),
  );
  for (const [index, section] of bySize.entries()) {
    const share = section.minimumChars + Math.floor(remaining / (bySize.length - index));
    if (section.resultBlock.length > share) {
      section.resultBlock = wrapPromptDataBlock({
        ...section.result,
        maxEscapedChars: share - resultFrameChars,
      });
    }
    remaining -= section.resultBlock.length - section.minimumChars;
  }
  return [
    heading,
    ...visible.map(({ header, resultBlock }) => `${header}\n${resultBlock}`),
    ...(summary ? [summary] : []),
  ].join("\n\n");
}
