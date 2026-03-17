import { resolveOutboundSendDep } from "../../../src/infra/outbound/send-deps.js";
import { sendMessageMatrix, sendPollMatrix } from "./matrix/send.js";
import { getMatrixRuntime } from "./runtime.js";
const matrixOutbound = {
  deliveryMode: "direct",
  chunker: (text, limit) => getMatrixRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4e3,
  sendText: async ({ cfg, to, text, deps, replyToId, threadId, accountId }) => {
    const send = resolveOutboundSendDep(deps, "matrix") ?? sendMessageMatrix;
    const resolvedThreadId = threadId !== void 0 && threadId !== null ? String(threadId) : void 0;
    const result = await send(to, text, {
      cfg,
      replyToId: replyToId ?? void 0,
      threadId: resolvedThreadId,
      accountId: accountId ?? void 0
    });
    return {
      channel: "matrix",
      messageId: result.messageId,
      roomId: result.roomId
    };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, deps, replyToId, threadId, accountId }) => {
    const send = resolveOutboundSendDep(deps, "matrix") ?? sendMessageMatrix;
    const resolvedThreadId = threadId !== void 0 && threadId !== null ? String(threadId) : void 0;
    const result = await send(to, text, {
      cfg,
      mediaUrl,
      replyToId: replyToId ?? void 0,
      threadId: resolvedThreadId,
      accountId: accountId ?? void 0
    });
    return {
      channel: "matrix",
      messageId: result.messageId,
      roomId: result.roomId
    };
  },
  sendPoll: async ({ cfg, to, poll, threadId, accountId }) => {
    const resolvedThreadId = threadId !== void 0 && threadId !== null ? String(threadId) : void 0;
    const result = await sendPollMatrix(to, poll, {
      cfg,
      threadId: resolvedThreadId,
      accountId: accountId ?? void 0
    });
    return {
      channel: "matrix",
      messageId: result.eventId,
      roomId: result.roomId,
      pollId: result.eventId
    };
  }
};
export {
  matrixOutbound
};
