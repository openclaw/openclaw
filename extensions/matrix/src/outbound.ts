import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/matrix";
import { sendMessageMatrix, sendPollMatrix } from "./matrix/send.js";
import { getMatrixRuntime } from "./runtime.js";

export const matrixOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getMatrixRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendPayload: async (ctx) => {
    const text = ctx.payload.text ?? "";
    const urls = ctx.payload.mediaUrls?.length
      ? ctx.payload.mediaUrls
      : ctx.payload.mediaUrl
        ? [ctx.payload.mediaUrl]
        : [];
    if (!text && urls.length === 0) {
      return { channel: "matrix", messageId: "" };
    }
    if (urls.length > 0) {
      // Matrix API supports one media attachment per event — send one event per URL
      let lastResult = await matrixOutbound.sendMedia!({
        ...ctx,
        text,
        mediaUrl: urls[0],
      });
      for (let i = 1; i < urls.length; i++) {
        lastResult = await matrixOutbound.sendMedia!({
          ...ctx,
          text: "",
          mediaUrl: urls[i],
        });
      }
      return lastResult;
    }
    const limit = matrixOutbound.textChunkLimit;
    const chunks = limit && matrixOutbound.chunker ? matrixOutbound.chunker(text, limit) : [text];
    if (!chunks.length) return { channel: "matrix", messageId: "" };
    let lastResult: Awaited<ReturnType<NonNullable<typeof matrixOutbound.sendText>>>;
    for (const chunk of chunks) {
      lastResult = await matrixOutbound.sendText!({ ...ctx, text: chunk });
    }
    return lastResult!;
  },
  sendText: async ({ cfg, to, text, deps, replyToId, threadId, accountId }) => {
    const send = deps?.sendMatrix ?? sendMessageMatrix;
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await send(to, text, {
      cfg,
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
  sendMedia: async ({ cfg, to, text, mediaUrl, deps, replyToId, threadId, accountId }) => {
    const send = deps?.sendMatrix ?? sendMessageMatrix;
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await send(to, text, {
      cfg,
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
  sendPoll: async ({ cfg, to, poll, threadId, accountId }) => {
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await sendPollMatrix(to, poll, {
      cfg,
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
