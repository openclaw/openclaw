/**
 * Middleware: create MessageSender + QueueSession and inject into ctx.
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

    // ⭐ Create MessageSender and inject into ctx.sender
    const target = isGroup ? groupCode! : fromAccount;
    const refMsgId = isGroup ? raw.msg_id || raw.msg_key : undefined;

    ctx.sender = createMessageSender({
      isGroup,
      account,
      target,
      fromAccount: account.botId || fromAccount, // Outbound messages are sent by the bot
      refMsgId,
      refFromAccount: isGroup ? fromAccount : undefined,
      wsClient,
      config,
      core,
      traceContext: ctx.traceContext,
    });

    // ⭐ Create QueueSession and inject into ctx.queueSession
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
