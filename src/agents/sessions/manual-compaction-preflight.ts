import {
  prepareCompactionEntries,
  type CompactionMessageProjection,
} from "../../../packages/agent-core/src/harness/compaction/compaction-preparation.js";
import type {
  CompactionPreparation,
  CompactionSettings,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { SessionEntry } from "./session-manager.js";

type ManualCompactionPreflight =
  | { compactable: true; preparation: CompactionPreparation }
  | { compactable: false; reason: "Already compacted" | "Nothing to compact (session too small)" };

/** Plans manual compaction without aborting or otherwise mutating the active session. */
export function preflightManualSessionCompaction(
  pathEntries: SessionEntry[],
  settings: CompactionSettings,
  onMessageProjection?: CompactionMessageProjection,
): ManualCompactionPreflight {
  let result = prepareCompactionEntries(
    pathEntries,
    settings,
    undefined,
    undefined,
    onMessageProjection,
  );
  if (result.ok && !result.value) {
    // Explicit manual compaction uses the smallest valid history rather than
    // treating a session that fits the configured keep budget as a no-op.
    result = prepareCompactionEntries(
      pathEntries,
      { ...settings, keepRecentTokens: 0 },
      undefined,
      undefined,
      onMessageProjection,
    );
  }
  if (!result.ok) {
    throw result.error;
  }
  const preparation = result.value;
  if (preparation) {
    return { compactable: true, preparation };
  }
  return {
    compactable: false,
    reason:
      pathEntries.at(-1)?.type === "compaction"
        ? "Already compacted"
        : "Nothing to compact (session too small)",
  };
}
