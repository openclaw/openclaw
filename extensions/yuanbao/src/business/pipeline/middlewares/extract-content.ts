/**
 * Middleware: extract text, media, and @mentions from raw MsgBody into PipelineContext.
 */

import { extractTextFromMsgBody } from "../../messaging/extract.js";
import type { MiddlewareDescriptor } from "../types.js";

export const extractContent: MiddlewareDescriptor = {
  name: "extract-content",
  handler: async (ctx, next) => {
    const { raw, isGroup } = ctx;

    ctx.fromAccount = raw.from_account?.trim() || "unknown";
    ctx.senderNickname = raw.sender_nickname?.trim() || undefined;

    if (isGroup) {
      ctx.groupCode = raw.group_code?.trim() || "unknown";
    } else if (raw.private_from_group_code) {
      // Direct message opened from group chat panel; carry group_code
      ctx.groupCode = raw.private_from_group_code;
    }

    // Build minimal ctx compatible with extractTextFromMsgBody's MessageHandlerContext
    // Note: MessageHandlerContext.log needs verbose method, but ModuleLog doesn't have it
    const minCtx = {
      account: ctx.account,
      config: ctx.config,
      core: ctx.core,
      log: { info: () => {}, warn: () => {}, error: () => {}, verbose: () => {} },
      wsClient: ctx.wsClient,
      groupCode: ctx.groupCode,
    };

    const { rawBody, isAtBot, medias, mentions, linkUrls } = extractTextFromMsgBody(
      minCtx,
      raw.msg_body,
    );

    ctx.rawBody = rawBody;
    ctx.isAtBot = isAtBot;
    ctx.medias = medias;
    ctx.mentions = mentions ?? [];
    ctx.linkUrls = linkUrls ?? [];

    ctx.log.info("[extract-content] received message", {
      isGroup,
      from: ctx.fromAccount,
      nickname: ctx.senderNickname,
      groupCode: ctx.groupCode,
      msgSeq: raw.msg_seq,
      msgKey: raw.msg_key,
      isAtBot,
    });

    await next();
  },
};
