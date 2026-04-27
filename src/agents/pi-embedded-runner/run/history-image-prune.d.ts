import type { AgentMessage } from "@mariozechner/pi-agent-core";
export declare const PRUNED_HISTORY_IMAGE_MARKER = "[image data removed - already processed by model]";
/**
 * Idempotent cleanup: prune persisted image blocks from completed turns older
 * than {@link PRESERVE_RECENT_COMPLETED_TURNS}. The delay also reduces
 * prompt-cache churn, though prefix stability additionally depends on the
 * replay sanitizer being idempotent.
 */
export declare function pruneProcessedHistoryImages(messages: AgentMessage[]): boolean;
