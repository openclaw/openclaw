import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { stripCompactionReplayCheckpoint } from "../../../../ai/src/transports/provider-compaction-checkpoint.js";
import { getOpenClawSystemUpdateKind } from "../../operator-messages.js";
import type { AgentMessage } from "../../types.js";
import {
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
} from "../messages.js";
import type { SessionContext, SessionTreeEntry } from "../types.js";
import {
  isPendingBackgroundResultMessage,
  projectPlacedBackgroundResultMessage,
  readBackgroundResultPlacement,
} from "./background-result-placement.js";
import { selectResetKeptEntries } from "./tool-result-pairing.js";
import { isTranscriptArtifactProvider } from "./transcript-model.js";

const SESSION_HISTORY_PRELUDE = Symbol.for("openclaw.sessionHistoryPrelude");

function isExcludedCustomMessage(entry: Extract<SessionTreeEntry, { type: "custom_message" }>) {
  // Existing failure receipts predate the generic context exclusion marker.
  return entry.excludeFromContext === true || entry.customType === "run-failed-before-reply";
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
      return "excludeFromContext" in entry.message && entry.message.excludeFromContext === true
        ? undefined
        : entry.message;
    case "custom_message":
      if (isExcludedCustomMessage(entry)) {
        return undefined;
      }
      return createCustomMessage(
        entry.customType,
        entry.content,
        entry.display,
        entry.details,
        entry.timestamp,
      );
    case "branch_summary":
      return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
    case "compaction":
      return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
    default:
      return undefined;
  }
}

/** Select the canonical window using only navigation and tool-pairing facts. */
export function* iterateSessionContextEntries<T extends SessionTreeEntry>(
  pathEntries: readonly T[],
): Generator<{ entry: T; placement?: T; context: "current" | "retained" | "reset-retained" }> {
  const { boundaryIndex, firstKeptIndex } = resolveSessionContextWindow(pathEntries);
  // A rebuilt prefix retires prompt overrides; retained turns still own their runtime facts.
  const operatorBoundaryIndex = Math.max(
    boundaryIndex,
    pathEntries.findLastIndex(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "openclaw.system-prompt" &&
        asOptionalRecord(entry.data)?.restart === true,
    ),
  );
  const boundary = pathEntries[boundaryIndex];
  let byId: Map<string, T> | undefined;
  const placedEntries = (entry: T) => {
    const placement = readBackgroundResultPlacement(entry);
    if (!placement) {
      return undefined;
    }
    const sources = (byId ??= new Map(pathEntries.map((source) => [source.id, source])));
    return placement.resultEntryIds.map((id) => {
      const source = sources.get(id);
      if (source?.type !== "message" || !isPendingBackgroundResultMessage(source.message)) {
        throw new Error(`Background result placement payload is unavailable: ${id}`);
      }
      return source;
    });
  };
  const resetKept =
    boundary?.type === "reset"
      ? new Set(
          selectResetKeptEntries(
            pathEntries
              .slice(firstKeptIndex, boundaryIndex)
              .flatMap(
                (entry) =>
                  placedEntries(entry) ??
                  (entry.type === "message" && isPendingBackgroundResultMessage(entry.message)
                    ? []
                    : [entry]),
              ),
          ),
        )
      : undefined;
  if (boundary) {
    yield { entry: boundary, context: "current" };
  }
  let index = -1;
  const placed = new Set<string>();
  for (const entry of pathEntries) {
    index += 1;
    const retained = index < boundaryIndex;
    if (index === boundaryIndex || (retained && index < firstKeptIndex)) {
      continue;
    }
    const context = retained ? (resetKept ? "reset-retained" : "retained") : "current";
    const results = placedEntries(entry);
    if (results) {
      for (const result of results) {
        if ((!retained || !resetKept || resetKept.has(result)) && !placed.has(result.id)) {
          placed.add(result.id);
          yield { entry: result, placement: entry, context };
        }
      }
      continue;
    }
    if (
      (retained && resetKept && !resetKept.has(entry)) ||
      (entry.type === "message" && isPendingBackgroundResultMessage(entry.message))
    ) {
      continue;
    }
    if (index < operatorBoundaryIndex && getOpenClawSystemUpdateKind(entry) === "prompt-update") {
      continue;
    }
    const hasMessage =
      entry.type === "message" ||
      entry.type === "custom_message" ||
      entry.type === "branch_summary";
    if (
      !hasMessage ||
      (entry.type === "custom_message" && isExcludedCustomMessage(entry)) ||
      (!resetKept?.has(entry) &&
        entry.type === "message" &&
        "excludeFromContext" in entry.message &&
        entry.message.excludeFromContext === true)
    ) {
      continue;
    }
    yield { entry, context };
  }
}

/** Hydrate selected messages lazily so bounded consumers can stop before later payloads. */
export function* iterateSessionContextMessages<T extends SessionTreeEntry>(
  pathEntries: readonly T[],
  readEntry: (entry: T) => SessionTreeEntry = (entry) => entry,
): Generator<AgentMessage> {
  for (const { entry, placement, context } of iterateSessionContextEntries(pathEntries)) {
    if (entry.type === "reset") {
      continue;
    }
    const hydrated = readEntry(entry);
    if (hydrated.type === "branch_summary" && !hydrated.summary) {
      continue;
    }
    // Explicit reset retention can include otherwise excluded user/assistant messages.
    let message =
      placement && hydrated.type === "message"
        ? projectPlacedBackgroundResultMessage(hydrated.message)
        : context === "reset-retained" && hydrated.type === "message"
          ? hydrated.message
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
    } else if (entry.type === "model_change" && !isTranscriptArtifactProvider(entry.provider)) {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      !isTranscriptArtifactProvider(entry.message.provider)
    ) {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    }
  }
  return { messages: Array.from(iterateSessionContextMessages(pathEntries)), thinkingLevel, model };
}
