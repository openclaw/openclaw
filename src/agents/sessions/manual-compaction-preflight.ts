import {
  prepareCompactionEntries,
  type CompactionMessageProjection,
} from "../../../packages/agent-core/src/harness/compaction/compaction-preparation.js";
import type {
  CompactionPreparation,
  CompactionSettings,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { CompactionError, Result } from "../../../packages/agent-core/src/harness/types.js";
import type { SessionEntry } from "./session-manager.js";

type ManualCompactionPreflight<P = CompactionPreparation> =
  | { compactable: true; preparation: P }
  | { compactable: false; reason: "Already compacted" | "Nothing to compact (session too small)" };

/** Plans manual compaction without aborting or otherwise mutating the active session. */
export function preflightManualSessionCompaction(
  pathEntries: SessionEntry[],
  settings: CompactionSettings,
  onMessageProjection?: CompactionMessageProjection,
): ManualCompactionPreflight {
  return preflightManualCompactionPreparation(
    settings,
    pathEntries.at(-1)?.type,
    (selectedSettings) =>
      prepareCompactionEntries(
        pathEntries,
        selectedSettings,
        undefined,
        undefined,
        onMessageProjection,
      ),
  );
}

/** Array and fact callers share the explicit manual minimum-tail retry and no-op reason. */
export function preflightManualCompactionPreparation<P>(
  settings: CompactionSettings,
  lastEntryType: string | undefined,
  prepare: (settings: CompactionSettings) => Result<P | undefined, CompactionError>,
): ManualCompactionPreflight<P> {
  let result = prepare(settings);
  if (result.ok && !result.value) {
    // Explicit manual compaction uses the smallest valid history rather than
    // treating a session that fits the configured keep budget as a no-op.
    result = prepare({ ...settings, keepRecentTokens: 0 });
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
      lastEntryType === "compaction"
        ? "Already compacted"
        : "Nothing to compact (session too small)",
  };
}
