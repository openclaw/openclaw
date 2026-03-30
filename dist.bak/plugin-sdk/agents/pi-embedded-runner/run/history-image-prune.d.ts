import type { AgentMessage } from "@mariozechner/pi-agent-core";
export declare const PRUNED_HISTORY_IMAGE_MARKER = "[image data removed - already processed by model]";
/**
 * Idempotent cleanup for legacy sessions that persisted image blocks in history.
 * Called each run; mutates only user turns that already have an assistant reply.
 */
export declare function pruneProcessedHistoryImages(messages: AgentMessage[]): boolean;
