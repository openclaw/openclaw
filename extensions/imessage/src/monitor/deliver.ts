import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import { deliverTextOrMediaReply } from "openclaw/plugin-sdk/reply-payload";
import { chunkTextWithMode, resolveChunkMode } from "openclaw/plugin-sdk/reply-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-runtime";
import type { createIMessageRpcClient } from "../client.js";
import { sendMessageIMessage } from "../send.js";
import type { SentMessageCache } from "./echo-cache.js";
import { sanitizeOutboundText } from "./sanitize-outbound.js";

export async function deliverReplies(params: {
  replies: ReplyPayload[];
  target: string;
  client: Awaited<ReturnType<typeof createIMessageRpcClient>>;
  accountId?: string;
  runtime: RuntimeEnv;
  maxBytes: number;
  textLimit: number;
  sentMessageCache?: Pick<SentMessageCache, "remember">;
}) {
  const { replies, target, client, runtime, maxBytes, textLimit, accountId, sentMessageCache } =
    params;
  const scope = `${accountId ?? ""}:${target}`;
  const cfg = loadConfig();
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "imessage",
    accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "imessage", accountId);
  for (const payload of replies) {
    const rawText = sanitizeOutboundText(payload.text ?? "");
    const text = convertMarkdownTables(rawText, tableMode);
    const hasMedia = Boolean(payload.mediaUrls?.length ?? payload.mediaUrl);
    if (!hasMedia && text) {
      sentMessageCache?.remember(scope, { text });
    }
    const delivered = await deliverTextOrMediaReply({
      payload,
      text,
      chunkText: (value) => chunkTextWithMode(value, textLimit, chunkMode),
      sendText: async (chunk) => {
        const sent = await sendMessageIMessage(target, chunk, {
          maxBytes,
          client,
          accountId,
          replyToId: payload.replyToId,
        });
        sentMessageCache?.remember(scope, { text: chunk, messageId: sent.messageId });
      },
      sendMedia: async ({ mediaUrl, caption }) => {
        const sent = await sendMessageIMessage(target, caption ?? "", {
          mediaUrl,
          maxBytes,
          client,
          accountId,
          replyToId: payload.replyToId,
        });
        sentMessageCache?.remember(scope, {
          text: caption || undefined,
          messageId: sent.messageId,
        });
      },
    });
    if (delivered !== "empty") {
      runtime.log?.(`imessage: delivered reply to ${target}`);
    }
  }
}
