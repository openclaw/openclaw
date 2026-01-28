import type { MoltbotConfig } from "clawdbot/plugin-sdk";

import type { KakaoFetch } from "./api.js";
import { sendMessage, openConversation } from "./api.js";
import { resolveKakaoAccount } from "./accounts.js";
import { resolveKakaoProxyFetch } from "./proxy.js";
import { resolveKakaoToken } from "./token.js";

export type KakaoSendOptions = {
  appKey?: string;
  accountId?: string;
  cfg?: MoltbotConfig;
  verbose?: boolean;
  proxy?: string;
};

export type KakaoSendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

function resolveSendContext(options: KakaoSendOptions): {
  appKey: string;
  fetcher?: KakaoFetch;
} {
  if (options.cfg) {
    const account = resolveKakaoAccount({
      cfg: options.cfg,
      accountId: options.accountId,
    });
    const appKey = options.appKey || account.appKey;
    const proxy = options.proxy ?? account.config.proxy;
    return { appKey, fetcher: resolveKakaoProxyFetch(proxy) };
  }

  const appKey = options.appKey ?? resolveKakaoToken(undefined, options.accountId).token;
  const proxy = options.proxy;
  return { appKey, fetcher: resolveKakaoProxyFetch(proxy) };
}

export async function sendMessageKakao(
  conversationId: string,
  text: string,
  options: KakaoSendOptions = {},
): Promise<KakaoSendResult> {
  const { appKey, fetcher } = resolveSendContext(options);

  if (!appKey) {
    return { ok: false, error: "No KakaoWork app key configured" };
  }

  if (!conversationId?.trim()) {
    return { ok: false, error: "No conversation_id provided" };
  }

  const numericId = parseInt(conversationId.trim(), 10);
  if (Number.isNaN(numericId)) {
    return { ok: false, error: "Invalid conversation_id format" };
  }

  try {
    const response = await sendMessage(
      appKey,
      {
        conversation_id: numericId,
        text: text.slice(0, 4000),
      },
      fetcher,
    );

    if (response.success && response.message) {
      return { ok: true, messageId: response.message.id };
    }

    return { ok: false, error: "Failed to send message" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function openAndSendMessageKakao(
  userId: string,
  text: string,
  options: KakaoSendOptions = {},
): Promise<KakaoSendResult> {
  const { appKey, fetcher } = resolveSendContext(options);

  if (!appKey) {
    return { ok: false, error: "No KakaoWork app key configured" };
  }

  if (!userId?.trim()) {
    return { ok: false, error: "No user_id provided" };
  }

  const numericUserId = parseInt(userId.trim(), 10);
  if (Number.isNaN(numericUserId)) {
    return { ok: false, error: "Invalid user_id format" };
  }

  try {
    const convResponse = await openConversation(appKey, numericUserId, fetcher);

    if (!convResponse.success || !convResponse.conversation) {
      return { ok: false, error: "Failed to open conversation" };
    }

    const conversationId = parseInt(convResponse.conversation.id, 10);
    const msgResponse = await sendMessage(
      appKey,
      {
        conversation_id: conversationId,
        text: text.slice(0, 4000),
      },
      fetcher,
    );

    if (msgResponse.success && msgResponse.message) {
      return { ok: true, messageId: msgResponse.message.id };
    }

    return { ok: false, error: "Failed to send message" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
