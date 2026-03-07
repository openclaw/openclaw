/**
 * Proactive message sending: send text, files, and @all messages to
 * individual users or group chats via the Feishu API.
 *
 * Unlike the reactive reply flow (reply-dispatcher.ts), this module
 * sends messages proactively — initiated by the user asking the bot
 * to notify someone or a group.
 */

import fs from "node:fs";
import path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { checkPermissionError } from "./permissions.js";
import type { FeishuDomain } from "./types.js";

type SendResult = { messageId: string } | { error: string };

// ---------------------------------------------------------------------------
// Send text message
// ---------------------------------------------------------------------------

/**
 * Send a text message to a user (by open_id) or group (by chat_id).
 */
export async function sendTextMessage(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  receiveId: string;
  receiveIdType: "open_id" | "chat_id";
  text: string;
  log?: (msg: string) => void;
}): Promise<SendResult> {
  const { cfg, accountId, receiveId, receiveIdType, text, log } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured || !account.appId) {
    return { error: "Feishu account not configured" };
  }

  const client = createFeishuClient(account);

  try {
    const response = (await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    })) as { code?: number; msg?: string; data?: { message_id?: string } };

    if (response.code !== 0) {
      return handleSendError(response, account.appId, account.domain);
    }

    const messageId = response.data?.message_id ?? "";
    log?.(`feishu: sent text message ${messageId} to ${receiveId}`);
    return { messageId };
  } catch (err) {
    return handleSendError(err, account.appId, account.domain);
  }
}

// ---------------------------------------------------------------------------
// Send file message
// ---------------------------------------------------------------------------

/**
 * Upload a file and send it as a file message.
 */
export async function sendFileMessage(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  receiveId: string;
  receiveIdType: "open_id" | "chat_id";
  filePath: string;
  log?: (msg: string) => void;
}): Promise<SendResult> {
  const { cfg, accountId, receiveId, receiveIdType, filePath, log } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured || !account.appId) {
    return { error: "飞书账号未配置" };
  }

  if (!fs.existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }

  const client = createFeishuClient(account);
  const fileName = path.basename(filePath);
  const fileStream = fs.createReadStream(filePath);

  try {
    // Step 1: Upload file
    const uploadResponse = (await client.im.file.create({
      data: {
        file_type: "stream",
        file_name: fileName,
        file: fileStream,
      },
    })) as { code?: number; msg?: string; data?: { file_key?: string } };

    if (uploadResponse.code !== 0) {
      const permErr = checkPermissionError(
        uploadResponse,
        account.appId,
        "im:resource",
        account.domain,
      );
      if (permErr) return { error: permErr };
      return {
        error: `File upload failed: ${uploadResponse.msg || `code ${uploadResponse.code}`}`,
      };
    }

    const fileKey = uploadResponse.data?.file_key;
    if (!fileKey) {
      return { error: "File uploaded but no file_key returned" };
    }

    log?.(`feishu: uploaded file "${fileName}" → file_key=${fileKey}`);

    // Step 2: Send file message
    const sendResponse = (await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: "file",
        content: JSON.stringify({ file_key: fileKey }),
      },
    })) as { code?: number; msg?: string; data?: { message_id?: string } };

    if (sendResponse.code !== 0) {
      return handleSendError(sendResponse, account.appId, account.domain);
    }

    const messageId = sendResponse.data?.message_id ?? "";
    log?.(`feishu: sent file message ${messageId} to ${receiveId}`);
    return { messageId };
  } catch (err) {
    return handleSendError(err, account.appId, account.domain);
  }
}

// ---------------------------------------------------------------------------
// Send @all message (post type)
// ---------------------------------------------------------------------------

/**
 * Send a message mentioning @all in a group chat.
 * Uses msg_type=post with the at tag for user_id=all.
 */
export async function sendMentionAll(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  chatId: string;
  text: string;
  log?: (msg: string) => void;
}): Promise<SendResult> {
  const { cfg, accountId, chatId, text, log } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured || !account.appId) {
    return { error: "飞书账号未配置" };
  }

  const client = createFeishuClient(account);

  // Build rich text (post) content with @all
  const postContent = {
    zh_cn: {
      title: "",
      content: [[{ tag: "at", user_id: "all" }], [{ tag: "text", text }]],
    },
  };

  try {
    const response = (await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "post",
        content: JSON.stringify(postContent),
      },
    })) as { code?: number; msg?: string; data?: { message_id?: string } };

    if (response.code !== 0) {
      return handleSendError(response, account.appId, account.domain);
    }

    const messageId = response.data?.message_id ?? "";
    log?.(`feishu: sent @all message ${messageId} to group ${chatId}`);
    return { messageId };
  } catch (err) {
    return handleSendError(err, account.appId, account.domain);
  }
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

function handleSendError(err: unknown, appId: string, domain?: FeishuDomain): { error: string } {
  const permErr = checkPermissionError(err, appId, "im:message:send_as_bot", domain);
  if (permErr) return { error: permErr };

  if (typeof err === "object" && err !== null) {
    const msg = (err as { msg?: string }).msg;
    const code = (err as { code?: number }).code;
    if (msg || code) {
      return { error: `Send failed: ${msg || `code ${code}`}` };
    }
  }

  return { error: `Send failed: ${String(err)}` };
}
