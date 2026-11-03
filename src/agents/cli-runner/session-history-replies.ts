import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  normalizeInputProvenance,
  shouldPreserveUserFacingSessionStateForInputProvenance,
} from "../../sessions/input-provenance.js";
import type { SessionEntry, SessionMessageEntry } from "../sessions/session-manager.js";

type CliTurnKind = "ordinary" | "preserved" | "background";
export type CliReply = {
  index: number;
  kind: CliTurnKind;
};

export function readTranscriptRunMetadata(message: object) {
  return asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
}

// Legacy bindings use ordinary replies as their boundary; announcements may save only a reply.
export function classifyCliReplies(entries: SessionEntry[], provider: string | undefined) {
  const replies: CliReply[] = [];
  let kind: CliTurnKind = "ordinary";
  entries.forEach((entry, index) => {
    if (entry.type !== "message") {
      return;
    }
    const { message } = entry;
    if (message.role === "user") {
      const provenance = normalizeInputProvenance(
        "provenance" in message ? message.provenance : undefined,
      );
      kind = !shouldPreserveUserFacingSessionStateForInputProvenance(provenance)
        ? "ordinary"
        : provenance?.kind === "inter_session"
          ? "preserved"
          : "background";
    } else if (message.role === "assistant" && message.provider === provider) {
      const runId = readTranscriptRunMetadata(message)?.runId;
      const announced = typeof runId === "string" && runId.startsWith("announce:");
      replies.push({
        index,
        kind: announced ? "preserved" : kind,
      });
    }
  });
  return replies;
}

export function renderClaudeSessionGap(
  entries: SessionEntry[],
  replies: CliReply[],
  options:
    | {
        sessionKey?: string;
        historyToolAvailable: boolean;
        freshSession: boolean;
        /** Content is withheld, so only an ordinary reply proves the session saw a turn. */
        countPreservedTurns: boolean;
      }
    | undefined,
): string | undefined {
  if (!options) {
    return undefined;
  }
  // An empty Claude reply has no saved assistant row, so the next turn may repeat this note.
  const lastClaude =
    replies.findLast((reply) => !options.countPreservedTurns || reply.kind === "ordinary")?.index ??
    -1;
  if (!options.freshSession && lastClaude < 0) {
    return undefined;
  }
  const countsPreservedTurns =
    !options.freshSession &&
    replies.some((reply) => reply.index > lastClaude && reply.kind === "preserved");
  const gap = entries
    .slice(options.freshSession ? 0 : lastClaude + 1)
    .filter(
      (entry): entry is SessionMessageEntry =>
        entry.type === "message" &&
        (entry.message.role === "user" || entry.message.role === "assistant"),
    );
  const models = new Set<string>();
  for (const entry of gap) {
    if (entry.message.role === "assistant") {
      models.add(`${entry.message.provider}/${entry.message.model}`);
    }
  }
  const first = gap[0];
  const last = gap.at(-1);
  if (!first || !last || models.size === 0) {
    return undefined;
  }
  const modelNames = [...models].toSorted();
  const modelSummary = modelNames
    .slice(0, 4)
    .map((model) => JSON.stringify(truncateUtf16Safe(model, 120)))
    .join(", ");
  const readHint =
    options.historyToolAvailable && options.sessionKey
      ? ` Before answering a question that may depend on these messages, call mcp__openclaw__sessions_history(${JSON.stringify({ sessionKey: options.sessionKey, limit: 100 })}) to read them; page older messages with offset if needed.`
      : "";
  const description = options.freshSession
    ? "earlier messages in this chat"
    : countsPreservedTurns
      ? "messages recorded in this chat since your last reply here (possibly already in this session)"
      : "messages occurred outside this Claude session";
  return `[OpenClaw: ${gap.length} ${description} from ${first.timestamp} to ${last.timestamp}, using ${modelSummary}${modelNames.length > 4 ? ` (+${modelNames.length - 4} more models)` : ""}. Their contents are not included here.${readHint}]`;
}
