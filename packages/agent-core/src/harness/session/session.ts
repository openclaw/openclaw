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
import { selectResetKeptMessageFacts, type ToolPairingMessageFact } from "./tool-pairing-facts.js";
import { collectToolPairingMessageFact, selectResetKeptEntries } from "./tool-result-pairing.js";
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

export type SessionContextEntryFact = {
  id: string;
  type: SessionTreeEntry["type"];
  firstKeptEntryId?: string;
  role?: AgentMessage["role"];
  pairing?: ToolPairingMessageFact;
  excluded: boolean;
  promptBoundary: boolean;
  promptUpdate: boolean;
};

export function collectSessionContextEntryFact(entry: SessionTreeEntry): SessionContextEntryFact {
  const message = entry.type === "message" ? entry.message : undefined;
  return {
    id: entry.id,
    type: entry.type,
    firstKeptEntryId:
      entry.type === "compaction" || entry.type === "reset" ? entry.firstKeptEntryId : undefined,
    role: message?.role,
    pairing: message ? collectToolPairingMessageFact(message) : undefined,
    excluded:
      entry.type === "custom_message"
        ? isExcludedCustomMessage(entry)
        : Boolean(
            message && "excludeFromContext" in message && message.excludeFromContext === true,
          ),
    promptBoundary:
      entry.type === "custom" &&
      entry.customType === "openclaw.system-prompt" &&
      asOptionalRecord(entry.data)?.restart === true,
    promptUpdate: getOpenClawSystemUpdateKind(entry) === "prompt-update",
  };
}

export function selectResetKeptContextEntryFacts<T extends SessionContextEntryFact>(
  entries: readonly T[],
): T[] {
  return selectResetKeptMessageFacts(
    entries.flatMap((entry) =>
      entry.type === "message" && entry.role
        ? [{ entry, role: entry.role, pairing: entry.pairing, identity: entry }]
        : [],
    ),
  ).map(({ entry }) => entry);
}

/** The release array adapter and payload-free worker share exactly one window selector. */
export function* iterateSessionContextEntries<T extends SessionTreeEntry>(
  pathEntries: readonly T[],
) {
  const entries = pathEntries.map((source) => ({
    ...collectSessionContextEntryFact(source),
    source,
  }));
  for (const selected of iterateContextFacts(entries, (selectedFacts) => {
    const selectedSources = new Set(
      selectResetKeptEntries(selectedFacts.map((fact) => fact.source)),
    );
    return selectedFacts.filter((fact) => selectedSources.has(fact.source));
  })) {
    yield { entry: selected.entry.source, context: selected.context };
  }
}

export function* iterateSessionContextEntryFacts<T extends SessionContextEntryFact>(
  pathEntries: readonly T[],
) {
  yield* iterateContextFacts(pathEntries, selectResetKeptContextEntryFacts);
}

function* iterateContextFacts<T extends SessionContextEntryFact>(
  pathEntries: readonly T[],
  selectReset: (entries: readonly T[]) => T[],
): Generator<{ entry: T; context: "current" | "retained" | "reset-retained" }> {
  const { boundaryIndex, firstKeptIndex } = resolveSessionContextWindow(pathEntries);
  // A rebuilt prefix retires prompt overrides; retained turns still own their runtime facts.
  const operatorBoundaryIndex = Math.max(
    boundaryIndex,
    pathEntries.findLastIndex((entry) => entry.promptBoundary),
  );
  const boundary = pathEntries[boundaryIndex];
  const resetKept =
    boundary?.type === "reset"
      ? new Set(selectReset(pathEntries.slice(firstKeptIndex, boundaryIndex)))
      : undefined;
  if (boundary) {
    yield { entry: boundary, context: "current" };
  }
  let index = -1;
  for (const entry of pathEntries) {
    index += 1;
    const retained = index < boundaryIndex;
    if (
      index === boundaryIndex ||
      (retained && (index < firstKeptIndex || (resetKept && !resetKept.has(entry))))
    ) {
      continue;
    }
    if (index < operatorBoundaryIndex && entry.promptUpdate) {
      continue;
    }
    const hasMessage =
      entry.type === "message" ||
      entry.type === "custom_message" ||
      entry.type === "branch_summary";
    if (
      !hasMessage ||
      (entry.type === "custom_message" && entry.excluded) ||
      (!resetKept?.has(entry) && entry.type === "message" && entry.excluded)
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
  for (const selected of iterateSessionContextEntries(pathEntries)) {
    const message = projectSessionContextMessage(selected, readEntry);
    if (message) {
      yield message;
    }
  }
}

/** Project one selected entry without changing its canonical position or retained context. */
export function projectSessionContextMessage<T extends SessionTreeEntry>(
  { entry, context }: { entry: T; context: "current" | "retained" | "reset-retained" },
  readEntry: (entry: T) => SessionTreeEntry = (selected) => selected,
): AgentMessage | undefined {
  if (entry.type === "reset") {
    return undefined;
  }
  const hydrated = readEntry(entry);
  if (hydrated.type === "branch_summary" && !hydrated.summary) {
    return undefined;
  }
  // Explicit reset retention can include otherwise excluded user/assistant messages.
  let message =
    context === "reset-retained" && hydrated.type === "message"
      ? hydrated.message
      : projectSessionEntryMessage(hydrated);
  if (!message) {
    return undefined;
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
  return message;
}

/** Build model context from an ordered session branch and its latest state markers. */
export function buildSessionContext(pathEntries: readonly SessionTreeEntry[]): SessionContext {
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
