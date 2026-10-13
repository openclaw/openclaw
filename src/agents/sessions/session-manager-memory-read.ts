import type { SessionActorMemoryHistoryReads } from "../../config/sessions/session-actor-memory-history-contract.js";
import type { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import type { SessionManagerMemoryBinding } from "./session-manager-incognito-scope.js";

/** Selected memory reads share the actor lifetime, without native database claims. */
export function prepareSessionManagerMemoryRead(
  binding: SessionManagerMemoryBinding,
  signal?: AbortSignal,
) {
  const assertOwned = captureOwnedTranscriptWriteAssertion(binding.target);
  const assertCurrent = () => {
    signal?.throwIfAborted();
    assertOwned();
    binding.authority.assertCurrent();
    binding.actor.assertReadable();
  };
  return {
    assertCurrent,
    read<Key extends keyof SessionActorMemoryHistoryReads>(
      type: Key,
      input: SessionActorMemoryHistoryReads[Key]["input"],
    ) {
      return binding.storage.read({ type, input }, { ...binding.authority, assertCurrent });
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
