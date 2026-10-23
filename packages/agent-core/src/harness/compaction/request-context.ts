import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentMessage } from "../../types.js";
import { CompactionError, err, ok, type Result, type SessionTreeEntry } from "../types.js";
import { MAX_LATEST_USER_REQUEST_CHARS } from "./compaction-details.js";
import {
  findLatestCompactionUserMessage,
  formatCompactionUserLabel,
  getCompactionContent,
} from "./utils.js";

const LATEST_USER_REQUEST_TRUNCATED_MARKER = "\n[... latest user request truncated ...]\n";
const MAX_REQUIRED_ASK_CONTEXT_CHARS = 2_000;
const REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER = "\n[... split-turn ask context truncated ...]\n";

function extractLatestUserRequest(messages: AgentMessage[]): string | undefined {
  const message = findLatestCompactionUserMessage(
    messages,
    (candidate) => getCompactionContent(candidate.content).text,
  );
  const source = message ? getCompactionContent(message.content).text.trim() : "";
  if (!source || source.length <= MAX_LATEST_USER_REQUEST_CHARS) {
    return source || undefined;
  }
  const contentBudget = MAX_LATEST_USER_REQUEST_CHARS - LATEST_USER_REQUEST_TRUNCATED_MARKER.length;
  const headBudget = Math.floor(contentBudget / 2);
  return `${truncateUtf16Safe(source, headBudget)}${LATEST_USER_REQUEST_TRUNCATED_MARKER}${sliceUtf16Safe(source, -(contentBudget - headBudget))}`;
}

/** Bounds a split turn's source ask; the safeguard summary and the no-summary reduction share it. */
export function formatRequiredAskContext(rawAsk: string): string {
  const source = rawAsk.trim();
  if (source.length <= MAX_REQUIRED_ASK_CONTEXT_CHARS) {
    return source;
  }
  const contentBudget =
    MAX_REQUIRED_ASK_CONTEXT_CHARS - REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER.length;
  const headBudget = Math.floor(contentBudget / 2);
  const tailBudget = contentBudget - headBudget;
  return `${truncateUtf16Safe(source, headBudget)}${REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER}${sliceUtf16Safe(source, -tailBudget)}`;
}

export function resolveLatestUnresolvedUserRequest(params: {
  pathEntries: SessionTreeEntry[];
  contextMessages: AgentMessage[];
  requestState?: "unresolved";
  requestFromEntryId?: string;
  preserveFromEntryId?: string;
  previousLatestUnresolvedUserRequest?: string;
  getMessageFromEntry: (entry: SessionTreeEntry) => AgentMessage | undefined;
}): Result<string | undefined, CompactionError> {
  // An admitted request can have later internal updates. Without that identity,
  // only the latest input is known to belong to this run; do not scan past an
  // independent internal input and revive an older human task.
  const requestEntryId = params.requestFromEntryId ?? params.preserveFromEntryId;
  const admittedIndex = requestEntryId
    ? params.pathEntries.findIndex((entry) => entry.id === requestEntryId)
    : -1;
  const admittedEntry = params.pathEntries[admittedIndex];
  if (
    requestEntryId &&
    (!admittedEntry || params.getMessageFromEntry(admittedEntry)?.role !== "user")
  ) {
    return err(
      new CompactionError("invalid_session", "Compaction cannot find the admitted request."),
    );
  }
  const latestInput = params.contextMessages.findLast((message) => message.role === "user");
  const requestMessages =
    admittedIndex >= 0
      ? params.pathEntries.slice(admittedIndex).flatMap((entry) => {
          const message = params.getMessageFromEntry(entry);
          return message ? [message] : [];
        })
      : latestInput
        ? [latestInput]
        : [];
  const hasRequestInput = requestMessages.some((message) => message.role === "user");
  return ok(
    params.requestState
      ? (extractLatestUserRequest(requestMessages) ??
          (hasRequestInput ? undefined : params.previousLatestUnresolvedUserRequest))
      : undefined,
  );
}

export function formatSplitTurnSourceAsk(messages: AgentMessage[]): string {
  const sourceMessage = messages.findLast(
    (message): message is Extract<AgentMessage, { role: "user" }> =>
      message.role === "user" && Boolean(getCompactionContent(message.content).text.trim()),
  );
  if (!sourceMessage) {
    return "";
  }
  const sourceText = getCompactionContent(sourceMessage.content).text;
  const sourceLabel = formatCompactionUserLabel(sourceMessage);
  return formatRequiredAskContext(
    sourceLabel === "User" ? sourceText : `[${sourceLabel}]: ${sourceText}`,
  );
}
