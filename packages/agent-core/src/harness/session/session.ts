import { stripCompactionReplayCheckpoint } from "../../../../ai/src/transports/provider-compaction-checkpoint.js";
import {
  getOpenClawSystemUpdateKind,
  isSystemPromptUpdateBoundary,
} from "../../operator-messages.js";
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

/** Payload-free context selection; invalid placements are validated only when selected. */
export type SessionContextEntryFact = {
  id: string;
  type: SessionTreeEntry["type"];
  firstKeptEntryId?: string;
  role?: AgentMessage["role"];
  pairing?: ToolPairingMessageFact;
  pendingBackground: boolean;
  excluded: boolean;
  promptBoundary: boolean;
  promptUpdate: boolean;
  placementResultIds?: readonly string[] | "invalid";
};

export function collectSessionContextEntryFact(entry: SessionTreeEntry): SessionContextEntryFact {
  let placementResultIds: SessionContextEntryFact["placementResultIds"];
  try {
    placementResultIds = readBackgroundResultPlacement(entry)?.resultEntryIds.slice();
  } catch {
    placementResultIds = "invalid";
  }
  const message = entry.type === "message" ? entry.message : undefined;
  return {
    id: entry.id,
    type: entry.type,
    firstKeptEntryId:
      entry.type === "compaction" || entry.type === "reset" ? entry.firstKeptEntryId : undefined,
    role: message?.role,
    pairing: message ? collectToolPairingMessageFact(message) : undefined,
    pendingBackground: isPendingBackgroundResultMessage(message),
    excluded:
      entry.type === "custom_message"
        ? isExcludedCustomMessage(entry)
        : Boolean(
            message && "excludeFromContext" in message && message.excludeFromContext === true,
          ),
    promptBoundary: isSystemPromptUpdateBoundary(entry),
    promptUpdate: getOpenClawSystemUpdateKind(entry) === "prompt-update",
    placementResultIds,
  };
}

export function selectResetKeptContextEntryFacts<T extends SessionContextEntryFact>(
  entries: readonly T[],
  identity: (entry: T) => unknown = (entry) => entry,
): T[] {
  return selectResetKeptMessageFacts(
    entries.flatMap((entry) =>
      entry.type === "message" && entry.role
        ? [
            {
              entry,
              role: entry.role,
              pairing: entry.pairing,
              identity: identity(entry),
            },
          ]
        : [],
    ),
  ).map(({ entry }) => entry);
}

type ContextEntry = Pick<SessionContextEntryFact, "id" | "type" | "firstKeptEntryId">;
type ContextSelectionSource<T> = {
  promptBoundary: (entry: T) => boolean;
  placement: (entry: T) => readonly string[] | undefined;
  pending: (entry: T) => boolean;
  resetKept: (entries: T[]) => ReadonlySet<ContextEntry>;
  promptUpdate: (entry: T) => boolean;
  excluded: (entry: T) => boolean;
};

/** Array callers preserve entry identities and lazy projection/validation timing. */
export function* iterateSessionContextEntries<T extends SessionTreeEntry>(
  pathEntries: readonly T[],
) {
  yield* iterateContextSource(pathEntries, {
    promptBoundary: isSystemPromptUpdateBoundary,
    placement: (entry) => readBackgroundResultPlacement(entry)?.resultEntryIds,
    pending: (entry) => entry.type === "message" && isPendingBackgroundResultMessage(entry.message),
    resetKept: (entries) => new Set(selectResetKeptEntries(entries)),
    promptUpdate: (entry) => getOpenClawSystemUpdateKind(entry) === "prompt-update",
    excluded: (entry) =>
      entry.type === "custom_message"
        ? isExcludedCustomMessage(entry)
        : entry.type === "message" &&
          "excludeFromContext" in entry.message &&
          entry.message.excludeFromContext === true,
  });
}

/** Select the canonical window using only navigation and tool-pairing facts. */
export function* iterateSessionContextEntryFacts<T extends SessionContextEntryFact>(
  pathEntries: readonly T[],
) {
  yield* iterateContextSource(pathEntries, {
    promptBoundary: (entry) => entry.promptBoundary,
    placement: (entry) => {
      if (entry.placementResultIds === "invalid") {
        throw new Error("Invalid background result placement marker");
      }
      return entry.placementResultIds;
    },
    pending: (entry) => entry.pendingBackground,
    resetKept: (entries) => new Set(selectResetKeptContextEntryFacts(entries)),
    promptUpdate: (entry) => entry.promptUpdate,
    excluded: (entry) => entry.excluded,
  });
}

function* iterateContextSource<T extends ContextEntry>(
  pathEntries: readonly T[],
  source: ContextSelectionSource<T>,
): Generator<{ entry: T; placement?: T; context: "current" | "retained" | "reset-retained" }> {
  const { boundaryIndex, firstKeptIndex } = resolveSessionContextWindow(pathEntries);
  // A rebuilt prefix retires prompt overrides; retained turns still own their runtime facts.
  const operatorBoundaryIndex = pathEntries.findLastIndex(source.promptBoundary);
  const boundary = pathEntries[boundaryIndex];
  let byId: Map<string, T> | undefined;
  const placedEntries = (entry: T) => {
    const placement = source.placement(entry);
    if (!placement) {
      return undefined;
    }
    const sourcesById = (byId ??= new Map(
      pathEntries.map((candidate) => [candidate.id, candidate]),
    ));
    return placement.map((id) => {
      const result = sourcesById.get(id);
      if (result?.type !== "message" || !source.pending(result)) {
        throw new Error(`Background result placement payload is unavailable: ${id}`);
      }
      return result;
    });
  };
  const resetKept =
    boundary?.type === "reset"
      ? source.resetKept(
          pathEntries
            .slice(firstKeptIndex, boundaryIndex)
            .flatMap(
              (entry) =>
                placedEntries(entry) ??
                (entry.type === "message" && source.pending(entry) ? [] : [entry]),
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
      (entry.type === "message" && source.pending(entry))
    ) {
      continue;
    }
    if (index < operatorBoundaryIndex && source.promptUpdate(entry)) {
      continue;
    }
    const hasMessage =
      entry.type === "message" ||
      entry.type === "custom_message" ||
      entry.type === "branch_summary";
    if (
      !hasMessage ||
      (entry.type === "custom_message" && source.excluded(entry)) ||
      (!resetKept?.has(entry) && entry.type === "message" && source.excluded(entry))
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
  for (const selected of iterateSessionContextEntries(pathEntries)) {
    const message = projectSessionContextMessage(selected, readEntry);
    if (message) {
      yield message;
    }
  }
}

/** Project one selected entry without changing its canonical position or retained context. */
export function projectSessionContextMessage<T extends SessionTreeEntry>(
  {
    entry,
    placement,
    context,
  }: { entry: T; placement?: T; context: "current" | "retained" | "reset-retained" },
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
    placement && hydrated.type === "message"
      ? projectPlacedBackgroundResultMessage(hydrated.message)
      : context === "reset-retained" && hydrated.type === "message"
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
