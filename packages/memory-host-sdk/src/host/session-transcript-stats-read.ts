import { isMainThread } from "node:worker_threads";
import { readTranscriptStatsBatchReadOnlySync as readAccessorTranscriptStatsBatchReadOnlySync } from "../../../../src/config/sessions/session-accessor.sqlite-transcript-stats-read.js";
import { warnPluginSdkDeprecation } from "../../../../src/plugins/sdk-deprecation.js";
import { assertBoundIncognitoMemorySyncAccess } from "./session-memory-authority.js";

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
