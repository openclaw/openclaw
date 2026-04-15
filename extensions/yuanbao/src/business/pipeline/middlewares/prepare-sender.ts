/**
 * 中间件：创建 MessageSender + QueueSession 并注入到 ctx
 *
 * 从 PipelineContext 中自动Extract所有需要的参数，
 * 创建 MessageSender 注入到 ctx.sender，
 * 创建 QueueSession 注入到 ctx.queueSession，
 * 消除 dispatchReply 中的手动数据组装。
 */

import { createMessageSender } from "../../outbound/create-sender.js";
import { createQueueSession } from "../../outbound/queue.js";
import type { MiddlewareDescriptor } from "../types.js";

export const prepareSender: MiddlewareDescriptor = {
  name: "prepare-sender",
  handler: async (ctx, next) => {
    const { account, isGroup, fromAccount, groupCode, raw, route, wsClient, config, core } = ctx;
    const outboundSessionKey =
      route?.sessionKey || (isGroup ? `group:${groupCode}` : `direct:${fromAccount}`);

    // ⭐ 创建 MessageSender 并注入到 ctx.sender
    const target = isGroup ? groupCode! : fromAccount;
    const refMsgId = isGroup ? raw.msg_id || raw.msg_key : undefined;

    ctx.sender = createMessageSender({
      isGroup,
      account,
      target,
      fromAccount: account.botId || fromAccount, // 出站消息是机器人发出
      refMsgId,
      refFromAccount: isGroup ? fromAccount : undefined,
      wsClient,
      config,
      core,
      traceContext: ctx.traceContext,
    });

    // ⭐ 创建 QueueSession 并注入到 ctx.queueSession
    const chunkText = (text: string, maxChars: number) =>
      core.channel.text.chunkMarkdownText(text, maxChars);

    ctx.queueSession = createQueueSession({
      sender: ctx.sender,
      strategy: account.disableBlockStreaming ? "immediate" : "merge-text",
      mergeOnFlush: account.disableBlockStreaming,
      sessionKey: outboundSessionKey,
      chunkText,
      onComplete: () => {
        ctx.log.debug(`[prepare-sender] [${outboundSessionKey}] outbound queue session completed`);
      },
    });

    ctx.log.debug(`[prepare-sender] [${outboundSessionKey}] sender + queueSession created`);

    await next();
  },
};
