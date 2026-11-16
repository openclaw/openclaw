import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuMediaList } from "./bot-content.js";
import { createFeishuClient } from "./client.js";
import type { FeishuMessageEvent } from "./event-types.js";
import type { FeishuMediaInfo, ResolvedFeishuAccount } from "./types.js";

/**
 * Resolve media for the current message, and when @-mentioned in a group
 * but the @ message itself carries no image, attach image messages among
 * the most recent group messages so the model can see screenshots the user
 * sent before @-mentioning the bot (image-first-@-later), however much
 * later. Returns at most 5 lookback images; failures only log.
 */
export async function resolveFeishuMediaListWithLookback(params: {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  ctx: { chatId: string; messageId: string };
  event: FeishuMessageEvent;
  mediaMaxBytes: number;
  log: (msg: string) => void;
  isGroup: boolean;
}): Promise<FeishuMediaInfo[]> {
  const { cfg, account, ctx, event, mediaMaxBytes, log, isGroup } = params;
  const mediaList = await resolveFeishuMediaList({
    cfg,
    messageId: ctx.messageId,
    messageType: event.message.message_type,
    content: event.message.content,
    maxBytes: mediaMaxBytes,
    log,
    accountId: account.accountId,
  });
  if (!isGroup || mediaList.length > 0) {
    return mediaList;
  }
  try {
    const listResponse = await createFeishuClient(account).im.message.list({
      params: {
        container_id_type: "chat",
        container_id: ctx.chatId,
        sort_type: "ByCreateTimeDesc",
        page_size: 20,
      },
    });
    if (listResponse?.code === 0) {
      for (const item of listResponse.data?.items ?? []) {
        if (item.message_id === ctx.messageId) {
          continue;
        }
        if (item.msg_type !== "image" && item.msg_type !== "post") {
          continue;
        }
        const extra = await resolveFeishuMediaList({
          cfg,
          messageId: item.message_id ?? "",
          messageType: item.msg_type,
          content: item.body?.content ?? "",
          maxBytes: mediaMaxBytes,
          log,
          accountId: account.accountId,
        });
        mediaList.push(...extra);
        if (mediaList.length >= 5) {
          break;
        }
      }
      if (mediaList.length > 0) {
        log(
          `feishu[${account.accountId}]: attached ${mediaList.length} recent group image(s) to @-mention`,
        );
      }
    }
  } catch (err) {
    log(`feishu[${account.accountId}]: recent group image lookback failed: ${String(err)}`);
  }
  return mediaList;
}
