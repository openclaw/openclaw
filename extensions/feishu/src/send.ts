import type { ClawdbotConfig } from "clawdbot/plugin-sdk";

import { resolveFeishuAccount } from "./accounts.js";
import { sendMessage, replyMessage, type FeishuFetch } from "./api.js";
import type { FeishuReceiveIdType } from "./types.js";

export type FeishuSendOptions = {
  appId?: string;
  appSecret?: string;
  accountId?: string;
  cfg?: ClawdbotConfig;
  receiveIdType?: FeishuReceiveIdType;
  replyToMessageId?: string;
  mediaUrl?: string;
  verbose?: boolean;
  fetch?: FeishuFetch;
};

export type FeishuSendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

function resolveSendContext(options: FeishuSendOptions): {
  appId: string;
  appSecret: string;
  fetcher?: FeishuFetch;
} {
  if (options.cfg) {
    const account = resolveFeishuAccount({
      cfg: options.cfg,
      accountId: options.accountId,
    });
    const appId = options.appId || account.appId;
    const appSecret = options.appSecret || account.appSecret;
    return { appId, appSecret, fetcher: options.fetch };
  }

  const appId = options.appId ?? "";
  const appSecret = options.appSecret ?? "";
  return { appId, appSecret, fetcher: options.fetch };
}

/**
 * Determine the receive_id_type based on the target format.
 */
function inferReceiveIdType(target: string): FeishuReceiveIdType {
  const trimmed = target.trim();
  // chat_id starts with "oc_"
  if (trimmed.startsWith("oc_")) return "chat_id";
  // open_id starts with "ou_"
  if (trimmed.startsWith("ou_")) return "open_id";
  // union_id starts with "on_"
  if (trimmed.startsWith("on_")) return "union_id";
  // user_id is typically numeric or alphanumeric
  if (/^[a-zA-Z0-9]+$/.test(trimmed) && !trimmed.includes("@")) return "user_id";
  // email contains @
  if (trimmed.includes("@")) return "email";
  // default to open_id
  return "open_id";
}

/**
 * Build a Feishu interactive card with markdown content.
 * Card messages support rich markdown formatting in Feishu.
 */
function buildMarkdownCard(content: string): string {
  const card = {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    elements: [
      {
        tag: "markdown",
        content,
      },
    ],
  };
  return JSON.stringify(card);
}

/**
 * Send a message to a Feishu user or chat.
 * Uses interactive card format for markdown support.
 */
export async function sendMessageFeishu(
  to: string,
  text: string,
  options: FeishuSendOptions = {},
): Promise<FeishuSendResult> {
  const { appId, appSecret, fetcher } = resolveSendContext(options);

  if (!appId || !appSecret) {
    return { ok: false, error: "No Feishu app credentials configured" };
  }

  if (!to?.trim()) {
    return { ok: false, error: "No recipient provided" };
  }

  const receiveIdType = options.receiveIdType ?? inferReceiveIdType(to);

  // Build interactive card message content for markdown support
  const content = buildMarkdownCard(text);

  try {
    // If replying to a specific message
    if (options.replyToMessageId) {
      const response = await replyMessage(
        appId,
        appSecret,
        options.replyToMessageId,
        { msg_type: "interactive", content },
        { fetch: fetcher },
      );

      if (response.code === 0 && response.data) {
        return { ok: true, messageId: response.data.message_id };
      }
      return { ok: false, error: response.msg ?? "Failed to reply" };
    }

    // Send new message as interactive card
    const response = await sendMessage(
      appId,
      appSecret,
      { receive_id: to.trim(), msg_type: "interactive", content },
      receiveIdType,
      { fetch: fetcher },
    );

    if (response.code === 0 && response.data) {
      return { ok: true, messageId: response.data.message_id };
    }

    return { ok: false, error: response.msg ?? "Failed to send message" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Send an image message to a Feishu user or chat.
 * Note: Requires uploading image first via /im/v1/images, then sending with image_key.
 * For simplicity, this currently only supports image_key (pre-uploaded images).
 */
export async function sendImageFeishu(
  to: string,
  imageKey: string,
  options: FeishuSendOptions = {},
): Promise<FeishuSendResult> {
  const { appId, appSecret, fetcher } = resolveSendContext(options);

  if (!appId || !appSecret) {
    return { ok: false, error: "No Feishu app credentials configured" };
  }

  if (!to?.trim()) {
    return { ok: false, error: "No recipient provided" };
  }

  if (!imageKey?.trim()) {
    return { ok: false, error: "No image key provided" };
  }

  const receiveIdType = options.receiveIdType ?? inferReceiveIdType(to);
  const content = JSON.stringify({ image_key: imageKey.trim() });

  try {
    const response = await sendMessage(
      appId,
      appSecret,
      { receive_id: to.trim(), msg_type: "image", content },
      receiveIdType,
      { fetch: fetcher },
    );

    if (response.code === 0 && response.data) {
      return { ok: true, messageId: response.data.message_id };
    }

    return { ok: false, error: response.msg ?? "Failed to send image" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
