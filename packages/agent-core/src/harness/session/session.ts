import { stripCompactionReplayCheckpoint } from "@openclaw/ai/transports";
import { replaceRedactionProvenance } from "@openclaw/normalization-core/redaction-provenance";
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
 * Persisted transcripts wrap every mask they produce in explicit provenance
 * markers (`@openclaw/normalization-core/redaction-provenance`). Replaying those
 * mask bytes as real values makes models copy them into new tool calls, files, and
 * replies, so replay swaps each marked span for a re-derive instruction and leaves
 * every other byte untouched. The placeholder carries no marker, which keeps the
 * swap idempotent.
 */
const REPLAY_REDACTED_VALUE_PLACEHOLDER = "[redacted: re-derive this value, do not reuse]";

// No key is exempt from replacement. Persistence only marks masks it produced in the
// same pass, and it never redacts correlation fields (`idempotencyKey`, tool-call ids,
// tool-detail ids), so a marked span cannot appear where the exact bytes matter for
// tool/result pairing or dedupe identity. An earlier revision instead skipped whole
// subtrees by key name at every depth; that left nested payload lookalikes unprocessed
// and rewrote literal text that merely looked like a mask (#142821 review).
function replaceMarkedRedaction(text: string): string {
  return replaceRedactionProvenance(text, REPLAY_REDACTED_VALUE_PLACEHOLDER);
}

function isPlainReplayObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Swap persisted redaction masks for a re-derive placeholder throughout a replayed
 * message, preserving object identity when nothing matches.
 */
function sanitizeReplayedRedactionMasks<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (typeof value === "string") {
    // SAFETY: T is string in this branch; sanitize returns a string.
    return replaceMarkedRedaction(value) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const cached = seen.get(value);
  if (cached !== undefined) {
    // SAFETY: cache only holds this value's own prior T-typed result.
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
    // SAFETY: next is a same-shape copy, or value itself when untouched.
    const result = (next ?? value) as T;
    seen.set(value, result);
    return result;
  }
  if (!isPlainReplayObject(value)) {
    return value;
  }
  let next: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(value)) {
    const sanitized = sanitizeReplayedRedactionMasks(item, seen);
    if (sanitized !== item) {
      next ??= { ...value };
      next[key] = sanitized;
    }
  }
  // SAFETY: next is a same-shape copy, or value itself when untouched.
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
      // Only provenance-marked masks are rewritten; unmarked bytes are literal history (#142821).
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
