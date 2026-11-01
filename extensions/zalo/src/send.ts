import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { stripChannelTargetPrefix, stripTargetKindPrefix } from "openclaw/plugin-sdk/core";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveZaloAccount } from "./accounts.js";
import { sendMessage, sendPhoto } from "./api.js";
import { resolveZaloProxyFetch } from "./proxy.js";

export async function sendMessageZalo(
  chatId: string,
  rawText: string,
  options: {
    accountId?: string;
    cfg: OpenClawConfig;
    mediaUrl?: string;
    assertDirectAdapterHandoff?: () => void;
  },
): Promise<{ messageId: string; receipt: MessageReceipt }> {
  const account = resolveZaloAccount({ cfg: options.cfg, accountId: options.accountId });
  const { token } = account;
  const fetcher = resolveZaloProxyFetch(account.config.proxy);
  const normalizedChatId = token
    ? stripTargetKindPrefix(stripChannelTargetPrefix(chatId, "zalo", "zl"))
    : "";
  if (!token || !normalizedChatId) {
    throw new Error(token ? "No chat_id provided" : "No Zalo bot token configured");
  }

  const text = convertMarkdownTables(
    rawText,
    resolveMarkdownTableMode({ cfg: options.cfg, channel: "zalo", accountId: account.accountId }),
  );
  const photoUrl = options.mediaUrl?.trim();
  if (options.mediaUrl && !photoUrl && !text) {
    throw new Error("No photo URL provided");
  }
  const response = photoUrl
    ? await sendPhoto(
        token,
        { chat_id: normalizedChatId, photo: photoUrl, caption: text || undefined },
        fetcher,
        options.assertDirectAdapterHandoff,
      )
    : await sendMessage(
        token,
        { chat_id: normalizedChatId, text: truncateUtf16Safe(text, 2000) },
        fetcher,
        options.assertDirectAdapterHandoff,
      );
  if (!response.result) {
    throw new Error(photoUrl ? "Failed to send photo" : "Failed to send message");
  }
  const messageId = response.result.message_id ?? "";
  return {
    messageId,
    receipt: createMessageReceiptFromOutboundResults({
      results: messageId.trim()
        ? [{ channel: "zalo", messageId: messageId.trim(), chatId: normalizedChatId }]
        : [],
      kind: photoUrl ? "media" : "text",
    }),
  };
}
