import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { TwitchClientManager } from "./twitch-client.js";
import type { TwitchAccountConfig } from "./types.js";
import { stripMarkdownForTwitch } from "./utils/markdown.js";

function createTwitchSendReceipt(messageId?: string, channel?: string): MessageReceipt {
  return createMessageReceiptFromOutboundResults({
    results: messageId ? [{ channel: "twitch", messageId, conversationId: channel }] : [],
    kind: "text",
  });
}

// Callers retain their account and manager lifecycle; strip Markdown once before chunking.
export async function sendMessageTwitchInternal(params: {
  channel: string;
  text: string;
  cfg: OpenClawConfig;
  account: TwitchAccountConfig;
  accountId: string;
  clientManager: TwitchClientManager | undefined;
}) {
  const cleanedText = stripMarkdownForTwitch(params.text);
  if (!cleanedText) {
    return {
      outcome: "not_sent" as const,
      messageId: "",
      receipt: createTwitchSendReceipt(),
    };
  }

  if (!params.clientManager) {
    throw new Error(
      `Client manager not found for account: ${params.accountId}. Please start the Twitch gateway first.`,
    );
  }
  const result = await params.clientManager.sendMessage(
    params.account,
    params.channel,
    cleanedText,
    params.cfg,
    params.accountId,
  );
  if (!result.ok) {
    // The public boundary keeps the formatted message and omits the raw SDK cause.
    throw new Error(result.error);
  }
  const { messageId } = result;
  return {
    messageId,
    receipt: createTwitchSendReceipt(messageId, params.channel),
  };
}
