/**
 * Group chat message history state
 *
 * 集中管理群聊的两类历史缓存：
 *   - chatHistories      — 文本历史，供 AI 上下文拼接和Recall检测使用
 *   - chatMediaHistories — Media历史 LRU，生命周期与 chatHistories 解耦，
 *                          避免 @bot 后 history 被清空导致Media丢失
 */

import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";

// ============ 类型 ============

/** 扩展历史条目，额外保存当条消息携带的Media资源（供 @bot 时批量下载） */
export type GroupHistoryEntry = HistoryEntry & {
  medias?: Array<{ url: string; mediaName?: string }>;
};

/** 独立的Media历史条目 */
export type MediaHistoryEntry = {
  sender: string;
  messageId?: string;
  timestamp: number;
  medias: Array<{ url: string; mediaName?: string }>;
};

// ============ 状态 ============

/** 群聊消息历史 Map，key 为 groupCode */
export const chatHistories = new Map<string, GroupHistoryEntry[]>();

const MEDIA_HISTORY_MAX_PER_GROUP = 50;

/** Media历史 LRU，key 为 groupCode，不随 clearHistoryEntriesIfEnabled 清空 */
export const chatMediaHistories = new Map<string, MediaHistoryEntry[]>();

// ============ 操作 ============

/**
 * 将Media条目写入独立 LRU，超过上限时淘汰最旧条目。
 *
 * 与文本 `chatHistories` 解耦，避免 `@bot` 等流程清空文本历史后丢失待批量下载的Media引用。
 *
 * @param groupCode - Group identifier，与 `chatHistories` 的 Map key 一致
 * @param entry - 单条Media历史（发送者、时间戳、`medias` 列表等）；`medias` 为空时直接跳过
 * @returns 无
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
