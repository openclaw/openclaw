// Capturing read authority must not acquire a session actor or load its runtime.
import type { SessionTranscriptReadScope } from "../../../../src/config/sessions/session-accessor.types.js";
import { captureSessionActorStorageOwner } from "../../../../src/config/sessions/session-actor-storage-binding.js";
import { getAsyncWorkSignal } from "../../../../src/shared/async-work-scope.js";
import { IncognitoSessionSyncAccessError } from "../../../../src/state/incognito-session-error.js";

/** Synchronous SDK calls cannot open memory-only session storage. */
export function assertBoundIncognitoMemorySyncAccess(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "storePath" | "sessionKey">,
  method: string,
  replacement: string,
) {
  if (captureMemoryOwner(scope)) {
    throw new IncognitoSessionSyncAccessError(method, replacement);
  }
}

export function captureMemoryOwner(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "storePath" | "sessionKey">,
) {
  const signal = getAsyncWorkSignal();
  const assertCurrent = () => signal?.throwIfAborted();
  return captureSessionActorStorageOwner(scope, { assertCurrent, authorize: assertCurrent });
}
