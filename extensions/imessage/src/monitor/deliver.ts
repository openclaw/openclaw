import { createChannelDeliveryAccumulator } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { chunkMarkdownTextWithMode, resolveChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import {
  deliverTextOrMediaReply,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { sendMessageIMessage } from "../send.js";
import type { SentMessageCache } from "./echo-cache.js";
import { sanitizeOutboundText } from "./sanitize-outbound.js";

export async function deliverIMessageReply(params: {
  cfg: OpenClawConfig;
  payload: ReplyPayload;
  target: string;
  accountId?: string;
  runtime: RuntimeEnv;
  maxBytes: number;
  textLimit: number;
  sentMessageCache?: Pick<SentMessageCache, "remember">;
}) {
  const { payload, target, runtime, maxBytes, textLimit, accountId, sentMessageCache } = params;
  const scope = `${accountId ?? ""}:${target}`;
  const { cfg } = params;
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "imessage",
    accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "imessage", accountId);
  const rawText = sanitizeOutboundText(payload.text ?? "");
  const reply = resolveSendableOutboundReplyParts(payload, {
    text: convertMarkdownTables(rawText, tableMode),
  });
  const accepted = createChannelDeliveryAccumulator({
    kind: reply.mediaUrls.length > 0 ? "media" : "text",
  });
  const sendAccepted = async (text: string, mediaUrl?: string) => {
    const sent = await sendMessageIMessage(target, text, {
      config: cfg,
      ...(mediaUrl ? { mediaUrl, ...(payload.audioAsVoice ? { audioAsVoice: true } : {}) } : {}),
      maxBytes,
      accountId,
      replyToId: payload.replyToId,
    });
    accepted.add({ receipt: sent.receipt }, sent.sentText);
    const echoText = sent.echoText ?? (sent.sentText || undefined);
    sentMessageCache?.remember(scope, {
      ...(echoText ? { text: echoText } : {}),
      ...(sent.echoMedia ? { media: sent.echoMedia } : {}),
      messageId: sent.messageId,
    });
  };
  let delivered: Awaited<ReturnType<typeof deliverTextOrMediaReply>>;
  try {
    delivered = await deliverTextOrMediaReply({
      payload,
      text: reply.text,
      chunkText: (value) => chunkMarkdownTextWithMode(value, textLimit, chunkMode),
      sendText: sendAccepted,
      sendMedia: ({ mediaUrl, caption }) => sendAccepted(caption ?? "", mediaUrl),
    });
  } catch (error: unknown) {
    throw accepted.partialError(error);
  }
  const deliveryResult = accepted.result();
  if (delivered !== "empty") {
    runtime.log?.(`imessage: delivered reply to ${target}`);
  }
  return deliveryResult;
}

export function createIMessageEchoCachingSend(params: {
  accountId?: string;
  sentMessageCache?: Pick<SentMessageCache, "remember">;
}): typeof sendMessageIMessage {
  return async (target, text, opts) => {
    const sanitizedText = sanitizeOutboundText(text);
    const sent = await sendMessageIMessage(target, sanitizedText, opts);
    const scope = `${params.accountId ?? opts.accountId ?? ""}:${target}`;
    const echoText = sent.echoText ?? (sent.sentText || undefined);
    params.sentMessageCache?.remember(scope, {
      ...(echoText ? { text: echoText } : {}),
      ...(sent.echoMedia ? { media: sent.echoMedia } : {}),
      messageId: sent.messageId,
    });
    return sent;
  };
}
