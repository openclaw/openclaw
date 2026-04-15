/**
 * 中间件：Message contentExtract
 *
 * 从原始 MsgBody 中Extract文本、Media、@信息，填充到 PipelineContext。
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
      // 群聊内打开的私聊面板，需要携带 group_code
      ctx.groupCode = raw.private_from_group_code;
    }

    // 构建最小 ctx 兼容 extractTextFromMsgBody 的 MessageHandlerContext 参数
    // Note:MessageHandlerContext.log 需要 verbose 方法，而 ModuleLog 没有，因此手动构建
    const minCtx = {
      account: ctx.account,
      config: ctx.config,
      core: ctx.core,
      log: { info: () => {}, warn: () => {}, error: () => {}, verbose: () => {} },
      wsClient: ctx.wsClient,
      groupCode: ctx.groupCode,
    };

    const { rawBody, isAtBot, medias, mentions } = extractTextFromMsgBody(minCtx, raw.msg_body);

    ctx.rawBody = rawBody;
    ctx.isAtBot = isAtBot;
    ctx.medias = medias;
    ctx.mentions = mentions ?? [];

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
