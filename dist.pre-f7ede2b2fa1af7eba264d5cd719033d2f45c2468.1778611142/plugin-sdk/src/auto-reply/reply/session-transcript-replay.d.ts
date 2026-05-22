/** Tail kept so DM continuity survives silent session rotations. */
export declare const DEFAULT_REPLAY_MAX_MESSAGES = 6;
/**
 * Copy the tail of user/assistant JSONL records from a prior transcript into a
 * freshly-rotated one. Tool, system, and compaction records are skipped so
 * replay cannot reshape tool/role ordering, and the tail is aligned and
 * coalesced into alternating user/assistant turns so role-ordering resets
 * cannot immediately recur. Uses async I/O so long transcripts do not block
 * the event loop. Returns 0 on any error.
 */
export declare function replayRecentUserAssistantMessages(params: {
    sourceTranscript?: string;
    targetTranscript: string;
    newSessionId: string;
    maxMessages?: number;
}): Promise<number>;
