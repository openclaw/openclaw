/**
 * Middleware: media download
 *
 * 下载Image和文件到 agent 允许访问的Directory。
 * In group chat scenarios, historical media resources are also collected.
 */

import type { QuoteInfo } from "../../../types.js";
import {
  chatHistories,
  chatMediaHistories,
  recordMediaHistory,
} from "../../messaging/chat-history.js";
import type { MediaItem } from "../../messaging/handlers/types.js";
import { downloadMediasToLocalFiles } from "../../utils/media.js";
import type { MiddlewareDescriptor } from "../types.js";

/**
 * 从群聊历史记录中收集与当前 @bot 消息相关的Media资源
 */
function getHistoryMedias(
  groupCode: string,
  fromAccount: string,
  quoteInfo?: QuoteInfo,
): MediaItem[] {
  const historyMedias: MediaItem[] = [];
  const TEN_MINUTES_MS = 10 * 60 * 1000;

  const history = chatHistories.get(groupCode) ?? [];
  const now = Date.now();

  const recentHistory = history.filter(
    (entry) => entry.timestamp == null || now - entry.timestamp <= TEN_MINUTES_MS,
  );
  const lastUserHistory = recentHistory.findLast((entry) => entry.sender === fromAccount);
  if (lastUserHistory) {
    historyMedias.push(
      ...(lastUserHistory.medias ?? []).map((m) => ({
        mediaType: "image" as const,
        url: m.url,
        mediaName: m.mediaName,
      })),
    );
  }

  if (quoteInfo?.id) {
    const mediaList = chatMediaHistories.get(groupCode) ?? [];
    const quoteMedia = mediaList.findLast((entry) => entry.messageId === quoteInfo.id);
    if (quoteMedia) {
      const existingUrls = new Set(historyMedias.map((m) => m.url));
      historyMedias.push(
        ...quoteMedia.medias
          .filter((m) => !existingUrls.has(m.url))
          .map((m) => ({
            mediaType: "image" as const,
            url: m.url,
            mediaName: m.mediaName,
          })),
      );
    }
  }

  return historyMedias;
}

export const downloadMedia: MiddlewareDescriptor = {
  name: "download-media",
  when: (ctx) => !!ctx.medias,
  handler: async (ctx, next) => {
    const { medias, isGroup, groupCode, fromAccount, quoteInfo, account, core } = ctx;

    let allMedias = [...medias];

    // Group chat scenario:收集历史Media
    if (isGroup && groupCode) {
      const historyMedias = getHistoryMedias(groupCode, fromAccount, quoteInfo);

      // 记录当前消息的Media到独立 LRU
      if (medias.length > 0) {
        recordMediaHistory(groupCode, {
          sender: fromAccount,
          messageId: ctx.raw.msg_id ?? String(ctx.raw.msg_seq ?? ""),
          timestamp: Date.now(),
          medias,
        });
      }

      allMedias = [...historyMedias.filter((m) => m.url), ...medias];
    }

    // Download media到本地
    const { mediaPaths, mediaTypes } = await downloadMediasToLocalFiles(allMedias, account, core, {
      verbose: (msg) => ctx.log.debug(msg),
      warn: (msg) => ctx.log.warn(msg),
    });

    ctx.mediaPaths = mediaPaths;
    ctx.mediaTypes = mediaTypes;

    await next();
  },
};
