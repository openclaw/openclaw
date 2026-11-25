import type { StreamFn, ThinkingLevel } from "../../runtime/index.js";
import type { CompactionPreparation } from "../compaction/compaction.js";
import type { CompactionEntry, SessionEntry } from "../session-manager.js";

/**
 * Summarizes with the session's next prepared request plus `instructions` as one
 * appended user item; resolves to the summary text or rejects without writing.
 */
export type WarmCompactionSummary = (instructions: string, signal: AbortSignal) => Promise<string>;

/** Fired before context compaction (can be cancelled or customized) */
export interface SessionBeforeCompactEvent {
  type: "session_before_compact";
  preparation: CompactionPreparation;
  branchEntries: SessionEntry[];
  customInstructions?: string;
  signal: AbortSignal;
  /** Prepared reasoning level for extension-owned summarization. */
  thinkingLevel?: ThinkingLevel;
  /** Prepared provider stream for extension-owned summarization. */
  streamFn?: StreamFn;
  /**
   * Present at a request boundary: the first history summary may come from it. The
   * request already holds the previous summary and the whole history, so the
   * instructions omit both. A rejection should cancel this compaction.
   */
  warmSummary?: WarmCompactionSummary;
}

/** Fired after context compaction */
export interface SessionCompactEvent {
  type: "session_compact";
  compactionEntry: CompactionEntry;
  fromExtension: boolean;
}
