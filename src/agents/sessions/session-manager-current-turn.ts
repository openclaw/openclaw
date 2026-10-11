import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import { readTranscriptEventAtSeqSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import { readActiveTranscriptEntryAnchor } from "../../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { walkSessionCurrentTurn } from "../../config/sessions/session-entry-navigation.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import {
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  SYSTEM_UPDATE_MESSAGE_CUSTOM_TYPE,
} from "../internal-runtime-context.js";
import { isSessionContextMetadataEntry } from "./session-manager-codec.js";
import {
  prepareSessionManagerHydration,
  readSessionManagerActorTranscript,
} from "./session-manager-incognito.js";
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

/** @internal Committed manager facts for the current execution boundary. */
export const sessionManagerReadTranscriptStart: unique symbol = Symbol.for(
  "openclaw.session-manager.read-transcript-start",
);

export type CurrentTurnReplaySelection = {
  entryId: string;
  version: SessionTranscriptContextVersion;
  assertCurrent: () => void;
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
        (entry.customType === OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE ||
          entry.customType === SYSTEM_UPDATE_MESSAGE_CUSTOM_TYPE)) ||
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

export async function prepareCurrentTurnReplaySelection(
  readView: () => CurrentTurnView & {
    target: SessionManagerPersistenceTarget | undefined;
    version: SessionTranscriptContextVersion | undefined;
    pendingDeliberateAppend: boolean;
  },
  matchesUser: (entry: SessionEntry | undefined) => boolean,
  signal?: AbortSignal,
  manager?: object,
): Promise<CurrentTurnReplaySelection | undefined> {
  const view = readView();
  if (!view.target || !view.version) {
    return undefined;
  }
  const version = { ...view.version };
  const entryCount = view.entries.size;
  const assertOwned = captureOwnedTranscriptWriteAssertion(view.target);
  const reader = prepareSessionManagerHydration(view.target, { signal, manager });
  const assertCurrent = () => {
    signal?.throwIfAborted();
    assertOwned();
    reader.assertCurrent();
    const current = readView();
    if (
      current.target !== view.target ||
      current.version !== view.version ||
      current.entries !== view.entries ||
      current.entries.size !== entryCount ||
      current.parentId !== view.parentId ||
      current.pendingDeliberateAppend !== view.pendingDeliberateAppend
    ) {
      throw new Error("Session manager changed during replay preparation");
    }
  };
  assertCurrent();
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
  const transcript = readSessionManagerActorTranscript(view.target, version);
  const anchor = transcript
    ? transcript.anchors.find((candidate) => candidate.entryId === userId)
    : (
        await reader.readCurrentTurnEntry({
          entryId: userId,
          version,
          includeEntry: false,
        })
      ).anchor;
  assertCurrent();
  if (!anchor) {
    return undefined;
  }
  assertCurrent();
  return { entryId: userId, version, assertCurrent };
}
