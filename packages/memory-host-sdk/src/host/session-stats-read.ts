// Keep worker statistics on the guarded reader without loading the session facade.
import { isMainThread } from "node:worker_threads";
import { readTranscriptStatsBatchReadOnlySync as readAccessorTranscriptStatsBatchReadOnlySync } from "../../../../src/config/sessions/session-accessor.sqlite-read.js";
import type { SessionTranscriptReadScope } from "../../../../src/config/sessions/session-accessor.types.js";
import { captureSessionActorStorageOwner } from "../../../../src/config/sessions/session-actor-storage-binding.js";
import { warnPluginSdkDeprecation } from "../../../../src/plugins/sdk-deprecation.js";
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

/** @deprecated Await readTranscriptStatsBatchReadOnlyAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function readTranscriptStatsBatchReadOnlySync(
  scopes: Parameters<typeof readAccessorTranscriptStatsBatchReadOnlySync>[0],
) {
  if (isMainThread) {
    warnPluginSdkDeprecation({
      family: "session-store",
      method: "readTranscriptStatsBatchReadOnlySync",
      replacement: "readTranscriptStatsBatchReadOnlyAsync",
    });
  }
  for (const scope of scopes) {
    assertBoundIncognitoMemorySyncAccess(
      scope,
      "readTranscriptStatsBatchReadOnlySync",
      "readTranscriptStatsBatchReadOnlyAsync",
    );
  }
  return readAccessorTranscriptStatsBatchReadOnlySync(scopes);
}

export function captureMemoryOwner(
  scope: Pick<SessionTranscriptReadScope, "agentId" | "env" | "storePath" | "sessionKey">,
) {
  const signal = getAsyncWorkSignal();
  const assertCurrent = () => signal?.throwIfAborted();
  return captureSessionActorStorageOwner(scope, { assertCurrent, authorize: assertCurrent });
}
