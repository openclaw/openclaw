import type {
  SessionActorMemoryHistoryReads,
  SessionActorMemoryHistoryQuery,
} from "../../config/sessions/session-actor-memory-history-contract.js";
import { readSessionActorMemoryHistoryQuery } from "../../config/sessions/session-actor-memory-history-read.js";
import { createSessionActorMemoryState } from "../../config/sessions/session-actor-memory-state.js";
import type { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import {
  withSessionManagerMemoryActor,
  type SessionManagerMemoryBinding,
} from "./session-manager-incognito-scope.js";

/** Each read borrows admitted work or releases its own handle after taking a snapshot. */
export function prepareSessionManagerMemoryRead(
  binding: SessionManagerMemoryBinding,
  signal?: AbortSignal,
) {
  const assertOwned = captureOwnedTranscriptWriteAssertion(binding.target);
  const assertCurrent = () => {
    signal?.throwIfAborted();
    assertOwned();
    binding.authority.assertCurrent();
  };
  return {
    assertCurrent,
    read<Key extends keyof SessionActorMemoryHistoryReads>(
      type: Key,
      input: SessionActorMemoryHistoryReads[Key]["input"],
    ): Promise<SessionActorMemoryHistoryReads[Key]["output"]> {
      assertCurrent();
      return withSessionManagerMemoryActor(binding, false, async (selected) => {
        if (selected) {
          return selected.storage.read({ type, input }, { ...binding.authority, assertCurrent });
        }
        // Missing reads evaluate the ordinary history projection over a transient empty
        // value; they never allocate an owner, session record, worker, or database.
        const state = createSessionActorMemoryState({
          sessionKey: binding.target.sessionKey,
          database: { kind: "memory", handle: "absent", incarnation: "absent" },
        });
        // SAFETY: The generic key pairs this input with its closed history-query variant.
        const query = { type, input } as SessionActorMemoryHistoryQuery;
        const result = readSessionActorMemoryHistoryQuery(state, query, binding.database);
        // SAFETY: The dispatcher returns the output paired with this query key.
        return result as SessionActorMemoryHistoryReads[Key]["output"];
      });
    },
  };
}

export function prepareSessionManagerMemoryHydration(
  binding: SessionManagerMemoryBinding,
  limits?: { maxBytes: number; maxEvents: number },
  signal?: AbortSignal,
): ReturnType<typeof prepareSessionTranscriptHydration> {
  const target = captureSessionTranscriptTargetBinding(binding.target);
  const reader = prepareSessionManagerMemoryRead(binding, signal);
  const captured = {
    sessionId: target.sessionId,
    admission: resolveSessionTranscriptReadFence(target),
  };
  return {
    target,
    assertCurrent: reader.assertCurrent,
    read: () => reader.read("session.history.hydrate", { ...captured, limits }),
    readCurrentTurnEntry: (request) =>
      reader.read("session.history.current-turn-entry", { ...captured, ...request }),
    readMaintenance: (request) =>
      reader.read("session.history.maintenance", { ...captured, request }),
    readRecentActiveEvents: (maxEvents) =>
      reader.read("session.history.recent-active-events", { ...captured, maxEvents }),
    readLatestActiveMessage: () => reader.read("session.history.latest-active-message", captured),
  };
}
