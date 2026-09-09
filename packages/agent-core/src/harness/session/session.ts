import { stripCompactionReplayCheckpoint } from "@openclaw/ai/transports";
import type { AgentMessage } from "../../types.js";
import {
  asAgentMessage,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
} from "../messages.js";
import type { SessionContext, SessionTreeEntry } from "../types.js";
import { selectResetKeptEntries } from "./tool-result-pairing.js";

const SESSION_HISTORY_PRELUDE = Symbol.for("openclaw.sessionHistoryPrelude");

/**
 * Placeholder replayed in place of persisted redaction masks (#142821).
 *
 * Persisted transcripts store "***" / partial (first6…last4) masks produced by the
 * default-on shape/name battery. Replaying those bytes as real values makes models
 * copy masks into new tool calls, files, and replies, so replay swaps them for an
 * explicit re-derive instruction. The text carries no "*" or "…" runs, which keeps
 * this replacement idempotent.
 */
export const REPLAY_REDACTED_VALUE_PLACEHOLDER = "[redacted: re-derive this value, do not reuse]";

// Keys whose exact bytes replay depends on (tool/result pairing, dedupe identity).
// Persist preserves them unredacted, so replay must never rewrite them either.
// ponytail: denylist, not allowlist — every other string position is mask-eligible.
const REPLAY_PRESERVED_KEYS = new Set([
  "idempotencyKey",
  "toolCallId",
  "parentToolCallId",
  "runId",
  "scopeId",
  "afterEntryId",
  "id",
  // Opaque provider replay blobs carry their own persist-time validation; Anthropic
  // compaction data is free-form provider text where "***" can be legitimate.
  "providerReplay",
]);

function sanitizeReplayedString(value: string): string {
  if (!value.includes("***") && !value.includes("…")) {
    return value;
  }
  let next = value;
  if (next.includes("***")) {
    // Border-aware so markdown emphasis ("***bold italic***", "**bold**") survives.
    next = next.replace(
      /(^|[\s"'([{=:\n\r])\*\*\*(?=[\s"'()\]},.;:!?…\n\r]|$)/gu,
      `$1${REPLAY_REDACTED_VALUE_PLACEHOLDER}`,
    );
  }
  if (next.includes("…")) {
    // ponytail: whole-token heuristic — U+2026 never appears in real
    // credential-shaped replay values; prose ellipsis lacks the trailing token.
    next = next.replace(
      /[A-Za-z0-9+/=_:.,-]{2,}…[A-Za-z0-9+/=_:.,-]{2,}/gu,
      REPLAY_REDACTED_VALUE_PLACEHOLDER,
    );
  }
  return next;
}

function isPlainReplayObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Swap persisted redaction masks for a re-derive placeholder throughout a replayed
 * message, preserving object identity when nothing matches.
 */
export function sanitizeReplayedRedactionMasks<T>(
  value: T,
  seen = new WeakMap<object, unknown>(),
): T {
  if (typeof value === "string") {
    return sanitizeReplayedString(value) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const cached = seen.get(value);
  if (cached !== undefined) {
    return cached as T;
  }
  if (Array.isArray(value)) {
    let next: unknown[] | undefined;
    value.forEach((item, index) => {
      const sanitized = sanitizeReplayedRedactionMasks(item, seen);
      if (sanitized !== item && next === undefined) {
        next = [...value];
      }
      if (next !== undefined) {
        next[index] = sanitized;
      }
    });
    const result = (next ?? value) as T;
    seen.set(value, result);
    return result;
  }
  if (!isPlainReplayObject(value)) {
    return value;
  }
  let next: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(value)) {
    if (REPLAY_PRESERVED_KEYS.has(key)) {
      continue;
    }
    const sanitized = sanitizeReplayedRedactionMasks(item, seen);
    if (sanitized !== item) {
      next ??= { ...value };
      next[key] = sanitized;
    }
  }
  const result = (next ?? value) as T;
  seen.set(value, result);
  return result;
}

/** The same semantic cut is used before payload acquisition and when building messages. */
function resolveSessionContextWindow(
  entries: readonly { id: string; type: string; firstKeptEntryId?: string }[],
): { boundaryIndex: number; firstKeptIndex: number } {
  const boundaryIndex = entries.findLastIndex(
    (entry) => entry.type === "reset" || entry.type === "compaction",
  );
  const firstKeptIndex = entries.findIndex(
    (entry) => entry.id === entries[boundaryIndex]?.firstKeptEntryId,
  );
  return {
    boundaryIndex,
    firstKeptIndex:
      firstKeptIndex >= 0 && firstKeptIndex < boundaryIndex ? firstKeptIndex : boundaryIndex,
  };
}

/** Project persisted session entries into the message shared by replay and summarization. */
export function projectSessionEntryMessage(entry: SessionTreeEntry): AgentMessage | undefined {
  switch (entry.type) {
    case "message":
      // Display-only history stays persisted but never enters replay or summarization.
      if ("excludeFromContext" in entry.message && entry.message.excludeFromContext === true) {
        return undefined;
      }
      // Persisted redaction masks must never replay as real values (#142821).
      return sanitizeReplayedRedactionMasks(entry.message);
    case "custom_message":
      return sanitizeReplayedRedactionMasks(
        asAgentMessage(
          createCustomMessage(
            entry.customType,
            entry.content,
            entry.display,
            entry.details,
            entry.timestamp,
          ),
        ),
      );
    case "branch_summary":
      return sanitizeReplayedRedactionMasks(
        asAgentMessage(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)),
      );
    case "compaction":
      return sanitizeReplayedRedactionMasks(
        asAgentMessage(
          createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
        ),
      );
    default:
      return undefined;
  }
}

/** Select the canonical window using only navigation and tool-pairing facts. */
export function* iterateSessionContextEntries<T extends SessionTreeEntry>(
  pathEntries: readonly T[],
): Generator<{ entry: T; context: "current" | "retained" | "reset-retained" }> {
  const { boundaryIndex, firstKeptIndex } = resolveSessionContextWindow(pathEntries);
  const boundary = pathEntries[boundaryIndex];
  const resetKept =
    boundary?.type === "reset"
      ? new Set(selectResetKeptEntries(pathEntries.slice(firstKeptIndex, boundaryIndex)))
      : undefined;
  if (boundary) {
    yield { entry: boundary, context: "current" };
  }
  for (const [index, entry] of pathEntries.entries()) {
    const retained = index < boundaryIndex;
    if (
      index === boundaryIndex ||
      (retained && (index < firstKeptIndex || (resetKept && !resetKept.has(entry))))
    ) {
      continue;
    }
    const hasMessage =
      entry.type === "message" ||
      entry.type === "custom_message" ||
      entry.type === "branch_summary";
    if (
      !hasMessage ||
      (!resetKept?.has(entry) &&
        entry.type === "message" &&
        "excludeFromContext" in entry.message &&
        entry.message.excludeFromContext === true)
    ) {
      continue;
    }
    const context = retained ? (resetKept ? "reset-retained" : "retained") : "current";
    yield { entry, context };
  }
}

/** Hydrate selected messages lazily so bounded consumers can stop before later payloads. */
export function* iterateSessionContextMessages<T extends SessionTreeEntry>(
  pathEntries: readonly T[],
  readEntry: (entry: T) => SessionTreeEntry = (entry) => entry,
): Generator<AgentMessage> {
  for (const { entry, context } of iterateSessionContextEntries(pathEntries)) {
    if (entry.type === "reset") {
      continue;
    }
    const hydrated = readEntry(entry);
    if (hydrated.type === "branch_summary" && !hydrated.summary) {
      continue;
    }
    // Explicit reset retention can include otherwise excluded user/assistant messages.
    // The direct path bypasses projectSessionEntryMessage, so it sanitizes here (#142821).
    let message =
      context === "reset-retained" && hydrated.type === "message"
        ? sanitizeReplayedRedactionMasks(hydrated.message)
        : projectSessionEntryMessage(hydrated);
    if (!message) {
      continue;
    }
    if (context !== "current" && message.role === "assistant") {
      message = stripCompactionReplayCheckpoint(message);
    }
    if (context === "reset-retained" && (message.role === "user" || message.role === "assistant")) {
      message = { ...message };
      Object.defineProperty(message, SESSION_HISTORY_PRELUDE, {
        configurable: true,
        enumerable: false,
        value: true,
      });
    }
    yield message;
  }
}

/** Build model context from an ordered session branch and its latest state markers. */
export function buildSessionContext(pathEntries: SessionTreeEntry[]): SessionContext {
  let thinkingLevel = "off";
  let model: { provider: string; modelId: string } | null = null;
  for (const entry of pathEntries) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    }
  }
  return { messages: Array.from(iterateSessionContextMessages(pathEntries)), thinkingLevel, model };
}
