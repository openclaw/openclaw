import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import { readTranscriptEventAtSeqSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import { readActiveTranscriptEntryAnchor } from "../../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { walkSessionCurrentTurn } from "../../config/sessions/session-entry-navigation.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../internal-runtime-context.js";
import { isSessionContextMetadataEntry } from "./session-manager-codec.js";
import type { SessionEntry, SessionMessageEntry } from "./session-manager-types.js";
import type { SessionManagerPersistenceTarget } from "./session-manager-view-types.js";

/** @internal Replay preparation is not part of the public SessionManager API. */
export const sessionManagerPrepareCurrentTurnReplay: unique symbol = Symbol.for(
  "openclaw.session-manager.prepare-current-turn-replay",
);

/** @internal Runtime model history is not the raw persistence/navigation window. */
export const sessionManagerReadInitialContext: unique symbol = Symbol.for(
  "openclaw.session-manager.read-initial-context",
);

export type CurrentTurnReplayWitness = {
  anchor: TranscriptEntryAnchor;
  version: SessionTranscriptContextVersion;
};

type CurrentTurnView = {
  entries: ReadonlyMap<string, SessionEntry>;
  parentId: string | null;
  remainingAncestors: number;
  isInterruptedTail?: (entry: SessionEntry) => boolean;
};

function traversalEntry(
  entry: SessionEntry | undefined,
  entryId: string,
  isInterruptedTail: CurrentTurnView["isInterruptedTail"],
) {
  if (!entry || entry.id !== entryId) {
    return undefined;
  }
  return {
    id: entry.id,
    parentId: entry.parentId,
    traversable:
      isSessionContextMetadataEntry(entry) ||
      entry.type === "compaction" ||
      (entry.type === "custom_message" &&
        entry.customType === OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE) ||
      (isInterruptedTail?.(entry) ?? false),
  };
}

function omittedCustomMessage(
  event: unknown,
  anchor: TranscriptEntryAnchor | undefined,
): SessionMessageEntry | undefined {
  return anchor &&
    isIndexedSessionEntry(event) &&
    event.type === "message" &&
    event.message.role === "custom" &&
    event.id === anchor.entryId &&
    event.parentId === anchor.effectiveParentId
    ? event
    : undefined;
}

export function resolveCurrentTurnEntryId(
  view: CurrentTurnView & { target: SessionManagerPersistenceTarget | undefined },
  includeOmitted: boolean,
): string | null {
  const walk = walkSessionCurrentTurn(view.parentId, view.remainingAncestors);
  let next = walk.next();
  while (!next.done) {
    let entry = view.entries.get(next.value);
    if (!entry && includeOmitted && view.target) {
      const anchor = readActiveTranscriptEntryAnchor({ ...view.target, entryId: next.value });
      entry = omittedCustomMessage(
        anchor ? readTranscriptEventAtSeqSync(view.target, anchor.rawSeq)?.event : undefined,
        anchor,
      );
    }
    next = walk.next(traversalEntry(entry, next.value, view.isInterruptedTail));
  }
  return next.value;
}

export async function prepareCurrentTurnReplayWitness(
  readView: () => CurrentTurnView & {
    target: SessionManagerPersistenceTarget | undefined;
    version: SessionTranscriptContextVersion | undefined;
  },
  matchesUser: (entry: SessionEntry | undefined) => boolean,
  signal?: AbortSignal,
): Promise<CurrentTurnReplayWitness | undefined> {
  const view = readView();
  if (!view.target || !view.version) {
    return undefined;
  }
  const version = { ...view.version };
  const entryCount = view.entries.size;
  const assertOwned = captureOwnedTranscriptWriteAssertion(view.target);
  const assertCurrent = () => {
    assertOwned();
    const current = readView();
    if (
      current.target !== view.target ||
      current.version !== view.version ||
      current.entries !== view.entries ||
      current.entries.size !== entryCount ||
      current.parentId !== view.parentId
    ) {
      throw new Error("Session manager changed during replay preparation");
    }
  };
  assertCurrent();
  const reader = prepareSessionTranscriptHydration(view.target, undefined, signal);
  const walk = walkSessionCurrentTurn(view.parentId, view.remainingAncestors);
  let next = walk.next();
  let entry: SessionEntry | undefined;
  while (!next.done) {
    entry = view.entries.get(next.value);
    if (!entry) {
      const result = await reader.readCurrentTurnEntry({
        entryId: next.value,
        version,
        includeEntry: true,
      });
      reader.assertCurrent();
      assertCurrent();
      entry =
        isIndexedSessionEntry(result.event) && result.event.id === next.value
          ? result.event
          : undefined;
    }
    next = walk.next(traversalEntry(entry, next.value, view.isInterruptedTail));
  }
  const userId = next.value;
  if (!userId || entry?.id !== userId || !matchesUser(entry)) {
    return undefined;
  }
  const result = await reader.readCurrentTurnEntry({
    entryId: userId,
    version,
    includeEntry: false,
  });
  reader.assertCurrent();
  assertCurrent();
  return result.anchor ? { anchor: result.anchor, version: result.version } : undefined;
}
