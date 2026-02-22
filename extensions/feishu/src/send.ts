import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import type { MentionTarget } from "./mention.js";
import { buildMentionedMessage, buildMentionedCardContent } from "./mention.js";
import { getFeishuRuntime } from "./runtime.js";
import { assertFeishuMessageApiSuccess, toFeishuSendResult } from "./send-result.js";
import { resolveReceiveIdType, normalizeFeishuTarget } from "./targets.js";
import type { FeishuSendResult, ResolvedFeishuAccount } from "./types.js";

export type FeishuMessageInfo = {
  messageId: string;
  chatId: string;
  senderId?: string;
  senderOpenId?: string;
  content: string;
  contentType: string;
  createTime?: number;
};

/**
 * Get a message by its ID.
 * Useful for fetching quoted/replied message content.
 */
export async function getMessageFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
}): Promise<FeishuMessageInfo | null> {
  const { cfg, messageId, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  try {
    const response = (await client.im.message.get({
      path: { message_id: messageId },
    })) as {
      code?: number;
      msg?: string;
      data?: {
        items?: Array<{
          message_id?: string;
          chat_id?: string;
          msg_type?: string;
          body?: { content?: string };
          sender?: {
            id?: string;
            id_type?: string;
            sender_type?: string;
          };
          create_time?: string;
        }>;
      };
    };

    if (response.code !== 0) {
      return null;
    }

    const item = response.data?.items?.[0];
    if (!item) {
      return null;
    }

    // Parse content based on message type
    let content = item.body?.content ?? "";
    try {
      const parsed = JSON.parse(content);
      if (item.msg_type === "text" && parsed.text) {
        content = parsed.text;
      } else if (item.msg_type === "post") {
        // Extract readable text from rich text post
        const title = parsed.title || "";
        const blocks = parsed.content || [];
        const parts: string[] = [];
        if (title) parts.push(title);
        for (const paragraph of blocks) {
          if (Array.isArray(paragraph)) {
            const line = paragraph
              .map((el: any) => {
                if (el.tag === "text") return el.text || "";
                if (el.tag === "a") return el.text || el.href || "";
                if (el.tag === "at") return `@${el.user_name || el.user_id || ""}`;
                if (el.tag === "img") return "[图片]";
                if (el.tag === "media") return `[${el.file_name || "视频"}]`;
                return "";
              })
              .join("");
            if (line) parts.push(line);
          }
        }
        content = parts.join("\n") || content;
      } else if (item.msg_type === "interactive") {
        // Card message: extract what we can from degraded content
        // For full content recovery, use session log lookup at agent level
        {
          const cardTexts: string[] = [];
          const extractText = (els: unknown[]) => {
            for (const el of els) {
              const e = el as { tag?: string; text?: string; content?: string };
              if (
                e.tag === "text" ||
                e.tag === "lark_md" ||
                e.tag === "md" ||
                e.tag === "markdown"
              ) {
                const t = e.text ?? e.content ?? "";
                if (t) cardTexts.push(t);
              }
            }
          };
          // Try card body.elements (schema 2.0) or top-level elements
          const elements = parsed.body?.elements ?? parsed.elements ?? [];
          if (Array.isArray(elements)) {
            for (const row of elements) {
              if (Array.isArray(row)) extractText(row);
              else extractText([row]);
            }
          }
          if (cardTexts.length > 0) {
            content = cardTexts.join("\n");
          } else {
            // Fallback: try degraded post format
            const fallback = parsed.fallback_text || parsed.config?.fallback_text || "";
            if (fallback) {
              content = fallback;
            } else if (parsed.elements || parsed.title) {
              const title = parsed.title || "";
              const blocks = parsed.elements || parsed.content || [];
              const parts: string[] = [];
              if (title) parts.push(title);
              for (const paragraph of blocks) {
                if (Array.isArray(paragraph)) {
                  const line = paragraph
                    .map((el: any) => {
                      if (el.tag === "text") return el.text || "";
                      if (el.tag === "a") return el.text || el.href || "";
                      if (el.tag === "img") return "[图片]";
                      return "";
                    })
                    .join("");
                  if (line) parts.push(line);
                }
              }
              if (parts.length > 0) content = parts.join("\n");
            }
          }
        }
      }
    } catch {
      // Keep raw content if parsing fails
    }

    return {
      messageId: item.message_id ?? messageId,
      chatId: item.chat_id ?? "",
      senderId: item.sender?.id,
      senderOpenId: item.sender?.id_type === "open_id" ? item.sender?.id : undefined,
      content,
      contentType: item.msg_type ?? "text",
      createTime: item.create_time ? parseInt(item.create_time, 10) : undefined,
    };
  } catch {
    return null;
  }
}

export type SendFeishuMessageParams = {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  replyToMessageId?: string;
  /** Mention target users */
  mentions?: MentionTarget[];
  /** Account ID (optional, uses default if not specified) */
  accountId?: string;
};

function buildFeishuPostMessagePayload(params: { messageText: string }): {
  content: string;
  msgType: string;
} {
  const { messageText } = params;
  return {
    content: JSON.stringify({
      zh_cn: {
        content: [
          [
            {
              tag: "md",
              text: messageText,
            },
          ],
        ],
      },
    }),
    msgType: "post",
  };
}

export async function sendMessageFeishu(
  params: SendFeishuMessageParams,
): Promise<FeishuSendResult> {
  const { cfg, to, text, replyToMessageId, mentions, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const receiveId = normalizeFeishuTarget(to);
  if (!receiveId) {
    throw new Error(`Invalid Feishu target: ${to}`);
  }

  const receiveIdType = resolveReceiveIdType(receiveId);
  const tableMode = getFeishuRuntime().channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });

  // Build message content (with @mention support)
  let rawText = text ?? "";
  if (mentions && mentions.length > 0) {
    rawText = buildMentionedMessage(mentions, rawText);
  }
  const messageText = getFeishuRuntime().channel.text.convertMarkdownTables(rawText, tableMode);

  const { content, msgType } = buildFeishuPostMessagePayload({ messageText });

  if (replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        content,
        msg_type: msgType,
      },
    });
    assertFeishuMessageApiSuccess(response, "Feishu reply failed");
    return toFeishuSendResult(response, receiveId);
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: msgType,
    },
  });
  assertFeishuMessageApiSuccess(response, "Feishu send failed");
  return toFeishuSendResult(response, receiveId);
}

export type SendFeishuCardParams = {
  cfg: ClawdbotConfig;
  to: string;
  card: Record<string, unknown>;
  replyToMessageId?: string;
  accountId?: string;
};

// Card content cache removed — session logs are the reliable source for
// recovering sent card content. See MEMORY.md for the lookup procedure.

export async function sendCardFeishu(params: SendFeishuCardParams): Promise<FeishuSendResult> {
  const { cfg, to, card, replyToMessageId, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const receiveId = normalizeFeishuTarget(to);
  if (!receiveId) {
    throw new Error(`Invalid Feishu target: ${to}`);
  }

  const receiveIdType = resolveReceiveIdType(receiveId);
  const content = JSON.stringify(card);

  if (replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        content,
        msg_type: "interactive",
      },
    });
    assertFeishuMessageApiSuccess(response, "Feishu card reply failed");
    const result = toFeishuSendResult(response, receiveId);

    return result;
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: "interactive",
    },
  });
  assertFeishuMessageApiSuccess(response, "Feishu card send failed");
  const result = toFeishuSendResult(response, receiveId);
  return result;
}

export async function updateCardFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  card: Record<string, unknown>;
  accountId?: string;
}): Promise<void> {
  const { cfg, messageId, card, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const content = JSON.stringify(card);

  const response = await client.im.message.patch({
    path: { message_id: messageId },
    data: { content },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu card update failed: ${response.msg || `code ${response.code}`}`);
  }
}

/**
 * Build a Feishu interactive card with markdown content.
 * Cards render markdown properly (code blocks, tables, links, etc.)
 * Uses schema 2.0 format for proper markdown rendering.
 */
export function buildMarkdownCard(text: string): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: text,
        },
      ],
    },
  };
}

/**
 * Send a message as a markdown card (interactive message).
 * This renders markdown properly in Feishu (code blocks, tables, bold/italic, etc.)
 */
export async function sendMarkdownCardFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  text: string;
  replyToMessageId?: string;
  /** Mention target users */
  mentions?: MentionTarget[];
  accountId?: string;
}): Promise<FeishuSendResult> {
  const { cfg, to, text, replyToMessageId, mentions, accountId } = params;
  // Build message content (with @mention support)
  let cardText = text;
  if (mentions && mentions.length > 0) {
    cardText = buildMentionedCardContent(mentions, text);
  }
  const card = buildMarkdownCard(cardText);
  return sendCardFeishu({ cfg, to, card, replyToMessageId, accountId });
}

/**
 * Edit an existing text message.
 * Note: Feishu only allows editing messages within 24 hours.
 */
export async function editMessageFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  text: string;
  accountId?: string;
}): Promise<void> {
  const { cfg, messageId, text, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const tableMode = getFeishuRuntime().channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });
  const messageText = getFeishuRuntime().channel.text.convertMarkdownTables(text ?? "", tableMode);

  const { content, msgType } = buildFeishuPostMessagePayload({ messageText });

  const response = await client.im.message.update({
    path: { message_id: messageId },
    data: {
      msg_type: msgType,
      content,
    },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu message edit failed: ${response.msg || `code ${response.code}`}`);
  }
}
