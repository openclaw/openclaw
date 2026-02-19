import { clearSwappedFileStore } from "./file-store.js";
import { clearGroupSummaryStore, clearSummaryStore } from "./summary-store.js";

/**
 * Clear all decay stores (summary, group-summary, swapped-file) for a session.
 * Indices are positional and become invalid after compaction rewrites the session JSONL.
 */
export async function clearAllDecayStores(sessionFilePath: string): Promise<void> {
  await Promise.all([
    clearSummaryStore(sessionFilePath),
    clearGroupSummaryStore(sessionFilePath),
    clearSwappedFileStore(sessionFilePath),
  ]);
}
