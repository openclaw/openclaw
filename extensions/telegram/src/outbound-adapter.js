import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequence
} from "../../../src/channels/plugins/outbound/direct-text-media.js";
import {
  resolveOutboundSendDep
} from "../../../src/infra/outbound/send-deps.js";
import { markdownToTelegramHtmlChunks } from "./format.js";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";
import { sendMessageTelegram } from "./send.js";
function resolveTelegramSendContext(params) {
  const send = resolveOutboundSendDep(params.deps, "telegram") ?? sendMessageTelegram;
  return {
    send,
    baseOpts: {
      verbose: false,
      textMode: "html",
      cfg: params.cfg,
      messageThreadId: parseTelegramThreadId(params.threadId),
      replyToMessageId: parseTelegramReplyToMessageId(params.replyToId),
      accountId: params.accountId ?? void 0
    }
  };
}
async function sendTelegramPayloadMessages(params) {
  const telegramData = params.payload.channelData?.telegram;
  const quoteText = typeof telegramData?.quoteText === "string" ? telegramData.quoteText : void 0;
  const text = params.payload.text ?? "";
  const mediaUrls = resolvePayloadMediaUrls(params.payload);
  const payloadOpts = {
    ...params.baseOpts,
    quoteText
  };
  if (mediaUrls.length === 0) {
    return await params.send(params.to, text, {
      ...payloadOpts,
      buttons: telegramData?.buttons
    });
  }
  const finalResult = await sendPayloadMediaSequence({
    text,
    mediaUrls,
    send: async ({ text: text2, mediaUrl, isFirst }) => await params.send(params.to, text2, {
      ...payloadOpts,
      mediaUrl,
      ...isFirst ? { buttons: telegramData?.buttons } : {}
    })
  });
  return finalResult ?? { messageId: "unknown", chatId: params.to };
}
const telegramOutbound = {
  deliveryMode: "direct",
  chunker: markdownToTelegramHtmlChunks,
  chunkerMode: "markdown",
  textChunkLimit: 4e3,
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId }) => {
    const { send, baseOpts } = resolveTelegramSendContext({
      cfg,
      deps,
      accountId,
      replyToId,
      threadId
    });
    const result = await send(to, text, {
      ...baseOpts
    });
    return { channel: "telegram", ...result };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    threadId,
    forceDocument
  }) => {
    const { send, baseOpts } = resolveTelegramSendContext({
      cfg,
      deps,
      accountId,
      replyToId,
      threadId
    });
    const result = await send(to, text, {
      ...baseOpts,
      mediaUrl,
      mediaLocalRoots,
      forceDocument: forceDocument ?? false
    });
    return { channel: "telegram", ...result };
  },
  sendPayload: async ({
    cfg,
    to,
    payload,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    threadId
  }) => {
    const { send, baseOpts } = resolveTelegramSendContext({
      cfg,
      deps,
      accountId,
      replyToId,
      threadId
    });
    const result = await sendTelegramPayloadMessages({
      send,
      to,
      payload,
      baseOpts: {
        ...baseOpts,
        mediaLocalRoots
      }
    });
    return { channel: "telegram", ...result };
  }
};
export {
  sendTelegramPayloadMessages,
  telegramOutbound
};
