/**
 * Truncate a session JSONL file after compaction by removing only the
 * message entries that the compaction actually summarized.
 *
 * After compaction, the session file still contains all historical entries
 * even though `buildSessionContext()` logically skips entries before
 * `firstKeptEntryId`. Over many compaction cycles this causes unbounded
 * file growth (issue #39953).
 *
 * This function rewrites the file keeping:
 * 1. The session header
 * 2. All non-message session state (custom, model_change, thinking_level_change,
 *    session_info, custom_message, compaction entries)
 *    Note: label and branch_summary entries referencing removed messages are
 *    also dropped to avoid dangling metadata.
 * 3. All entries from sibling branches not covered by the compaction
 * 4. The unsummarized tail: entries from `firstKeptEntryId` through (and
 *    including) the compaction entry, plus all entries after it
 *
 * Only `message` entries in the current branch that precede the compaction's
 * `firstKeptEntryId` are removed — they are the entries the compaction
 * actually summarized. Entries from `firstKeptEntryId` onward are preserved
 * because `buildSessionContext()` expects them when reconstructing the
 * session. Entries whose parent was removed are re-parented to the nearest
 * kept ancestor (or become roots).
 */
export declare function truncateSessionAfterCompaction(params: {
    sessionFile: string;
    /** Optional path to archive the pre-truncation file. */
    archivePath?: string;
    ackMaxChars?: number;
    heartbeatPrompt?: string;
}): Promise<TruncationResult>;
export type TruncationResult = {
    truncated: boolean;
    entriesRemoved: number;
    bytesBefore?: number;
    bytesAfter?: number;
    reason?: string;
};
