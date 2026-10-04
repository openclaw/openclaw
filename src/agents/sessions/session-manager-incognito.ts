import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import {
  prepareIncognitoSessionTranscriptHydration,
  prepareSessionTranscriptHydration,
} from "../../config/sessions/session-transcript-hydration.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { captureSessionManagerIncognitoActor } from "./session-manager-incognito-scope.js";

/** SessionManager planning uses the same actor as its subsequent metadata command. */
export function prepareSessionManagerHydration(
  source: SessionTranscriptRuntimeTarget,
  limits?: { maxBytes: number; maxEvents: number },
  signal?: AbortSignal,
) {
  const target = captureSessionTranscriptTargetBinding(source);
  const actor = captureSessionManagerIncognitoActor(target);
  if (!actor) {
    return prepareSessionTranscriptHydration(target, limits, signal);
  }
  const assertOwned = captureOwnedTranscriptWriteAssertion(target);
  const lifecycleRevision = actor.sessions.readSharing(target.sessionKey)?.entry?.lifecycleRevision;
  const hydration = prepareIncognitoSessionTranscriptHydration({
    actor,
    authority: { assertCurrent: assertOwned },
    target: {
      sessionKey: target.sessionKey,
      sessionId: target.sessionId,
      lifecycleRevision,
      admission: resolveSessionTranscriptReadFence(target),
    },
    limits,
    signal,
  });
  // Keep the manager's captured writer binding and environment across hydration adoption.
  return { ...hydration, target };
}
