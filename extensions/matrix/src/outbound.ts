import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { sendMessageMatrix, sendPollMatrix } from "./matrix/send.js";
import { getMatrixRuntime } from "./runtime.js";

export const matrixOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getMatrixRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendFinal: async (ctx) => {
    const media =
      ctx.payload.mediaUrl ??
      (Array.isArray(ctx.payload.mediaUrls) && ctx.payload.mediaUrls.length > 0
        ? ctx.payload.mediaUrls[0]
        : undefined);
    if (media) {
      return matrixOutbound.sendMedia!({
        ...ctx,
        text: ctx.payload.text ?? ctx.text,
        mediaUrl: media,
        replyToId: ctx.payload.replyToId ?? ctx.replyToId,
      });
    }
    return matrixOutbound.sendText!({
      ...ctx,
      text: ctx.payload.text ?? ctx.text,
      replyToId: ctx.payload.replyToId ?? ctx.replyToId,
    });
  },
  sendText: async ({ to, text, deps, replyToId, threadId, accountId }) => {
    const send = deps?.sendMatrix ?? sendMessageMatrix;
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await send(to, text, {
      replyToId: replyToId ?? undefined,
      threadId: resolvedThreadId,
      accountId: accountId ?? undefined,
    });
    return {
      channel: "matrix",
      messageId: result.messageId,
      roomId: result.roomId,
    };
  },
  sendMedia: async ({ to, text, mediaUrl, deps, replyToId, threadId, accountId }) => {
    const send = deps?.sendMatrix ?? sendMessageMatrix;
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await send(to, text, {
      mediaUrl,
      replyToId: replyToId ?? undefined,
      threadId: resolvedThreadId,
      accountId: accountId ?? undefined,
    });
    return {
      channel: "matrix",
      messageId: result.messageId,
      roomId: result.roomId,
    };
  },
  sendPoll: async ({ to, poll, threadId, accountId }) => {
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await sendPollMatrix(to, poll, {
      threadId: resolvedThreadId,
      accountId: accountId ?? undefined,
    });
    return {
      channel: "matrix",
      messageId: result.eventId,
      roomId: result.roomId,
      pollId: result.eventId,
    };
  },
};
