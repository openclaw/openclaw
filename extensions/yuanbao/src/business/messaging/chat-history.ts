/**
 * Group chat message history state.
 *
 * Manages two types of group chat history caches:
 *   - chatHistories      — text history for AI context assembly and recall detection
 *   - chatMediaHistories — media history LRU, lifecycle decoupled from chatHistories
 *                          to prevent media loss when history is cleared after @bot
 */

import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";

// ============ Types ============

/** Extended history entry, additionally stores media resources carried by the message (for batch download on @bot) */
export type GroupHistoryEntry = HistoryEntry & {
  medias?: Array<{ url: string; mediaName?: string }>;
};

/** Standalone media history entry */
export type MediaHistoryEntry = {
  sender: string;
  messageId?: string;
  timestamp: number;
  medias: Array<{ url: string; mediaName?: string }>;
};

// ============ State ============

/** Group chat message history Map, keyed by groupCode */
export const chatHistories = new Map<string, GroupHistoryEntry[]>();

const MEDIA_HISTORY_MAX_PER_GROUP = 50;

/** Media history LRU, keyed by groupCode, not cleared by clearHistoryEntriesIfEnabled */
export const chatMediaHistories = new Map<string, MediaHistoryEntry[]>();

// ============ Operations ============

/**
 * Write media entry to standalone LRU, evicting oldest entries when exceeding limit.
 * Decoupled from text `chatHistories` to prevent media loss when text history is cleared after @bot.
 */
export function recordMediaHistory(groupCode: string, entry: MediaHistoryEntry): void {
  if (entry.medias.length === 0) {
    return;
  }
  let list = chatMediaHistories.get(groupCode);
  if (!list) {
    list = [];
    chatMediaHistories.set(groupCode, list);
  }
  list.push(entry);
  if (list.length > MEDIA_HISTORY_MAX_PER_GROUP) {
    list.splice(0, list.length - MEDIA_HISTORY_MAX_PER_GROUP);
  }
}
