import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { MentionTarget } from "./mention.js";
import type { FeishuSendResult, ResolvedFeishuAccount } from "./types.js";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { buildMentionedMessage, buildMentionedCardContent } from "./mention.js";
import { getFeishuRuntime } from "./runtime.js";
import { resolveReceiveIdType, normalizeFeishuTarget } from "./targets.js";

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
  cfg: OpenClawConfig;
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
  cfg: OpenClawConfig;
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

    if (response.code !== 0) {
      throw new Error(`Feishu reply failed: ${response.msg || `code ${response.code}`}`);
    }

    return {
      messageId: response.data?.message_id ?? "unknown",
      chatId: receiveId,
    };
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: msgType,
    },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu send failed: ${response.msg || `code ${response.code}`}`);
  }

  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId: receiveId,
  };
}

export type SendFeishuCardParams = {
  cfg: OpenClawConfig;
  to: string;
  card: Record<string, unknown>;
  replyToMessageId?: string;
  accountId?: string;
};

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

    if (response.code !== 0) {
      throw new Error(`Feishu card reply failed: ${response.msg || `code ${response.code}`}`);
    }

    return {
      messageId: response.data?.message_id ?? "unknown",
      chatId: receiveId,
    };
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: "interactive",
    },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu card send failed: ${response.msg || `code ${response.code}`}`);
  }

  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId: receiveId,
  };
}

/**
 * Build a Feishu card v2 with markdown content.
 * Cards render markdown properly (code blocks, tables, links, etc.)
 * Uses schema 2.0 format for proper markdown rendering.
 */
export function buildMarkdownCard(text: string): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      title: { content: "", tag: "plain_text" },
      template: "default",
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
  cfg: OpenClawConfig;
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
  cfg: OpenClawConfig;
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

export const STREAMING_ELEMENT_ID = "streaming_md";
const STREAM_PRINT_FREQUENCY_MS = 70;
const STREAM_PRINT_STEP = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getNested(value: unknown, keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    const obj = asRecord(current);
    if (!obj || !(key in obj)) {
      return undefined;
    }
    current = obj[key];
  }
  return current;
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sanitizeStreamingContent(text: string): string {
  // Strip non-printable control chars except newline/tab/carriage return.
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

type StreamingCardPayload = {
  schema: "2.0";
  config: {
    streaming_mode: true;
    update_multi: true;
    summary: { content: string };
    streaming_config?: {
      print_frequency_ms: { default: number; android?: number; ios?: number; pc?: number };
      print_step: { default: number; android?: number; ios?: number; pc?: number };
      print_strategy: "fast" | "delay";
    };
  };
  body: {
    elements: Array<{
      tag: "markdown";
      content: string;
      element_id: string;
    }>;
  };
  header?: {
    title: {
      tag: "plain_text";
      content: string;
    };
  };
};

function buildStreamingCardPayloadVariants(
  initialContent: string,
  summaryText = "Generating ...",
): Array<{
  name: string;
  payload: StreamingCardPayload;
}> {
  const content = sanitizeStreamingContent(initialContent || "Generating response...");

  return [
    {
      name: "no-header+full-streaming-config",
      payload: {
        schema: "2.0",
        config: {
          streaming_mode: true,
          update_multi: true,
          summary: { content: summaryText },
          streaming_config: {
            print_frequency_ms: { default: STREAM_PRINT_FREQUENCY_MS },
            print_step: { default: STREAM_PRINT_STEP },
            print_strategy: "fast",
          },
        },
        body: {
          elements: [
            {
              tag: "markdown",
              content,
              element_id: STREAMING_ELEMENT_ID,
            },
          ],
        },
      },
    },
    {
      name: "header+full-streaming-config",
      payload: {
        schema: "2.0",
        header: {
          title: {
            tag: "plain_text",
            content: "OpenClaw",
          },
        },
        config: {
          streaming_mode: true,
          update_multi: true,
          summary: { content: summaryText },
          streaming_config: {
            print_frequency_ms: { default: STREAM_PRINT_FREQUENCY_MS },
            print_step: { default: STREAM_PRINT_STEP },
            print_strategy: "fast",
          },
        },
        body: {
          elements: [
            {
              tag: "markdown",
              content,
              element_id: STREAMING_ELEMENT_ID,
            },
          ],
        },
      },
    },
    {
      name: "header+minimal-streaming-config",
      payload: {
        schema: "2.0",
        header: {
          title: {
            tag: "plain_text",
            content: "OpenClaw",
          },
        },
        config: {
          streaming_mode: true,
          update_multi: true,
          summary: { content: summaryText },
        },
        body: {
          elements: [
            {
              tag: "markdown",
              content,
              element_id: STREAMING_ELEMENT_ID,
            },
          ],
        },
      },
    },
  ];
}

export type CreateCardEntityResult = {
  cardId: string;
};

export function buildStreamingCardData(initialContent: string, summaryText?: string): string {
  const [first] = buildStreamingCardPayloadVariants(initialContent, summaryText);
  if (!first) {
    return "{}";
  }
  return JSON.stringify(first.payload);
}

export async function createCardEntityFeishu(params: {
  cfg: OpenClawConfig;
  initialContent?: string;
  accountId?: string;
}): Promise<CreateCardEntityResult> {
  const { cfg, initialContent = "", accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  const variants = buildStreamingCardPayloadVariants(initialContent);
  let lastError: unknown;

  for (let i = 0; i < variants.length; i += 1) {
    const variant = variants[i];
    if (!variant) {
      continue;
    }
    const data = JSON.stringify(variant.payload);

    try {
      const response = (await client.cardkit.v1.card.create({
        data: {
          type: "card_json",
          data,
        },
      })) as { code?: number; msg?: string; data?: { card_id?: string }; log_id?: string };

      if (response.code === 0 && response.data?.card_id) {
        return { cardId: response.data.card_id };
      }

      const msg = response.msg || `code ${response.code}`;
      lastError = new Error(`Feishu CardKit create failed: ${msg}`);
    } catch (err) {
      lastError = err;
    }
  }

  throw (
    lastError ??
    new Error(
      `Feishu CardKit create failed: all payload variants rejected for account ${account.accountId}`,
    )
  );
}

export async function updateCardSummaryFeishu(params: {
  cfg: OpenClawConfig;
  cardId: string;
  summaryText: string;
  content: string;
  sequence: number;
  accountId?: string;
}): Promise<void> {
  const { cfg, cardId, summaryText, content, sequence, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const cardApi = asRecord(getNested(client, ["cardkit", "v1", "card"]));
  const update = cardApi?.update;
  if (typeof update !== "function") {
    throw new Error("Feishu CardKit card.update API unavailable");
  }

  const cardJson = buildStreamingCardData(content, summaryText);
  const response = (await (update as (payload: unknown) => Promise<unknown>)({
    path: { card_id: cardId },
    data: {
      card: {
        type: "card_json",
        data: cardJson,
      },
      sequence,
    },
  })) as { code?: number; msg?: string; log_id?: string };

  if (response.code !== 0) {
    throw new Error(
      `Feishu CardKit summary update failed: ${response.msg || `code ${response.code}`}`,
    );
  }

  console.info(
    `feishu[${account.accountId}] card.summary updated: cardId=${cardId}, sequence=${sequence}, summary=${summaryText}`,
  );
}

export async function sendCardByCardIdFeishu(params: {
  cfg: OpenClawConfig;
  to: string;
  cardId: string;
  replyToMessageId?: string;
  accountId?: string;
}): Promise<FeishuSendResult> {
  const { cfg, to, cardId, replyToMessageId, accountId } = params;
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
  // Official card-id send shape: {"type":"card","data":{"card_id":"..."}}
  const content = JSON.stringify({
    type: "card",
    data: {
      card_id: cardId,
    },
  });

  if (replyToMessageId) {
    try {
      const response = await client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: "interactive" },
      });

      if (response.code !== 0) {
        throw new Error(`Feishu card-id reply failed: ${response.msg || `code ${response.code}`}`);
      }

      return {
        messageId: response.data?.message_id ?? "unknown",
        chatId: receiveId,
      };
    } catch (err) {
      const code = getNested(err, ["response", "data", "code"]);
      const msg = getNested(err, ["response", "data", "msg"]);
      const logId = getNested(err, ["response", "data", "log_id"]);
      const details = getNested(err, ["response", "data"]);
      console.info(
        `feishu[${account.accountId}] card.bind reply error: code=${String(code ?? "")}, logId=${String(logId ?? "")}, msg=${String(msg ?? String(err))}, details=${stringifyJson(details)}`,
      );
      throw err;
    }
  }

  try {
    const response = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content,
        msg_type: "interactive",
      },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu card-id send failed: ${response.msg || `code ${response.code}`}`);
    }

    return {
      messageId: response.data?.message_id ?? "unknown",
      chatId: receiveId,
    };
  } catch (err) {
    const code = getNested(err, ["response", "data", "code"]);
    const msg = getNested(err, ["response", "data", "msg"]);
    const logId = getNested(err, ["response", "data", "log_id"]);
    const details = getNested(err, ["response", "data"]);
    console.info(
      `feishu[${account.accountId}] card.bind create error: code=${String(code ?? "")}, logId=${String(logId ?? "")}, msg=${String(msg ?? String(err))}, details=${stringifyJson(details)}`,
    );
    throw err;
  }
}

/** @param sequence Strictly increasing per card (1, 2, 3, …). */
export async function updateCardElementContentFeishu(params: {
  cfg: OpenClawConfig;
  cardId: string;
  content: string;
  sequence: number;
  elementId?: string;
  accountId?: string;
}): Promise<void> {
  const { cfg, cardId, content, sequence, elementId = STREAMING_ELEMENT_ID, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  const response = (await client.cardkit.v1.cardElement.content({
    path: { card_id: cardId, element_id: elementId },
    data: { content, sequence },
  })) as { code?: number; msg?: string };

  if (response.code !== 0) {
    throw new Error(
      `Feishu CardKit element update failed: ${response.msg || `code ${response.code}`}`,
    );
  }
}
