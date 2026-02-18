// Mux transport contract (versioned local copy for mux-server).
// Keep this module free of channel runtime dependencies.
export const MUX_CONTRACT_VERSION = 1;

export type MuxPayload = {
  requestId?: unknown;
  op?: unknown;
  action?: unknown;
  channel?: unknown;
  sessionKey?: unknown;
  accountId?: unknown;
  to?: unknown;
  text?: unknown;
  mediaUrl?: unknown;
  mediaUrls?: unknown;
  replyToId?: unknown;
  threadId?: unknown;
  channelData?: unknown;
  poll?: unknown;
  raw?: unknown;
  openclawId?: unknown;
};

export type MuxInboundAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: string;
  url?: string;
};

export type MuxInboundPayload = {
  eventId?: unknown;
  event?: {
    kind?: unknown;
    raw?: unknown;
  };
  channel?: unknown;
  sessionKey?: unknown;
  body?: unknown;
  from?: unknown;
  to?: unknown;
  accountId?: unknown;
  chatType?: unknown;
  messageId?: unknown;
  timestampMs?: unknown;
  threadId?: unknown;
  channelData?: unknown;
  attachments?: unknown;
  openclawId?: unknown;
};

export type MuxInboundEnvelope = {
  eventId: string;
  channel: "telegram" | "discord" | "whatsapp";
  event: {
    kind: "message" | "callback" | "command" | "action";
    raw: unknown;
  };
  raw: unknown;
  sessionKey: string;
  body: string;
  from: string;
  to: string;
  accountId: string;
  chatType: "direct" | "group";
  messageId: string;
  timestampMs: number;
  threadId?: number | string;
  channelData: Record<string, unknown>;
  attachments?: MuxInboundAttachment[];
  openclawId?: string;
};

export type MuxOutboundOperation = {
  op: "send" | "action";
  action?: string;
};

export type TelegramButtons = Array<Array<{ text: string; callback_data: string }>>;

export function asMuxRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function readMuxNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readMuxOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readMuxPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }
  return undefined;
}

export function normalizeMuxBaseUrl(value: unknown): string | undefined {
  const base = readMuxNonEmptyString(value);
  if (!base) {
    return undefined;
  }
  return base.replace(/\/+$/, "");
}

export function resolveMuxThreadId(
  threadId: unknown,
  channelData: Record<string, unknown> | undefined,
): string | number | undefined {
  if (typeof threadId === "number" && Number.isFinite(threadId)) {
    return Math.trunc(threadId);
  }
  if (typeof threadId === "string" && threadId.trim()) {
    return threadId.trim();
  }
  const topicId = channelData?.topicId;
  if (typeof topicId === "number" && Number.isFinite(topicId)) {
    return Math.trunc(topicId);
  }
  const rawThreadId = channelData?.threadId;
  if (typeof rawThreadId === "number" && Number.isFinite(rawThreadId)) {
    return Math.trunc(rawThreadId);
  }
  if (typeof rawThreadId === "string" && rawThreadId.trim()) {
    return rawThreadId.trim();
  }
  return undefined;
}

export function normalizeMuxInboundAttachments(input: unknown): MuxInboundAttachment[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((item) => {
      const attachment = item as {
        type?: unknown;
        mimeType?: unknown;
        fileName?: unknown;
        content?: unknown;
        url?: unknown;
      };
      const content =
        typeof attachment?.content === "string"
          ? attachment.content
          : ArrayBuffer.isView(attachment?.content)
            ? Buffer.from(
                attachment.content.buffer,
                attachment.content.byteOffset,
                attachment.content.byteLength,
              ).toString("base64")
            : undefined;
      const url =
        typeof attachment?.url === "string" && attachment.url.trim() ? attachment.url : undefined;
      if (!content && !url) {
        return null;
      }
      return {
        type: typeof attachment?.type === "string" ? attachment.type : undefined,
        mimeType: typeof attachment?.mimeType === "string" ? attachment.mimeType : undefined,
        fileName: typeof attachment?.fileName === "string" ? attachment.fileName : undefined,
        ...(content ? { content } : {}),
        ...(url ? { url } : {}),
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
}

export function toMuxInboundPayload(value: unknown): MuxInboundPayload {
  return (typeof value === "object" && value ? value : {}) as MuxInboundPayload;
}

export function readOutboundText(payload: MuxPayload): { text: string; hasText: boolean } {
  const text = typeof payload.text === "string" ? payload.text : "";
  return { text, hasText: text.trim().length > 0 };
}

export function collectOutboundMediaUrls(payload: MuxPayload): string[] {
  const collected: string[] = [];
  const single = typeof payload.mediaUrl === "string" ? payload.mediaUrl : "";
  if (single.trim().length > 0) {
    collected.push(single);
  }
  const list = Array.isArray(payload.mediaUrls) ? payload.mediaUrls : [];
  for (const item of list) {
    if (typeof item !== "string") {
      continue;
    }
    if (item.trim().length > 0) {
      collected.push(item);
    }
  }
  return collected;
}

export function readOutboundOperation(payload: MuxPayload): MuxOutboundOperation {
  const rawOp = typeof payload.op === "string" ? payload.op.trim().toLowerCase() : "";
  const rawAction =
    typeof payload.action === "string" ? payload.action.trim().toLowerCase() : undefined;
  if (rawOp === "action") {
    return { op: "action", action: rawAction };
  }
  if (rawOp === "typing") {
    return { op: "action", action: "typing" };
  }
  if (rawAction === "typing" && !rawOp) {
    return { op: "action", action: "typing" };
  }
  return { op: "send" };
}

export function readOutboundRaw(payload: MuxPayload): Record<string, unknown> | null {
  return asMuxRecord(payload.raw) ?? null;
}

export function readTelegramReplyToMessageId(replyToId?: string | null): number | undefined {
  if (!replyToId) {
    return undefined;
  }
  const parsed = Number.parseInt(replyToId, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readTelegramMessageThreadId(threadId?: string | number | null): number | undefined {
  if (threadId == null) {
    return undefined;
  }
  if (typeof threadId === "number") {
    return Number.isFinite(threadId) ? Math.trunc(threadId) : undefined;
  }
  const trimmed = threadId.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildTelegramReplyMarkup(buttons?: TelegramButtons) {
  if (!buttons?.length) {
    return undefined;
  }
  const rows = buttons
    .map((row) =>
      row
        .filter((button) => button?.text && button?.callback_data)
        .map((button) => ({
          text: button.text,
          callback_data: button.callback_data,
        })),
    )
    .filter((row) => row.length > 0);
  if (rows.length === 0) {
    return undefined;
  }
  return { inline_keyboard: rows };
}

export function buildTelegramRawSend(params: {
  to: string;
  text: string;
  mediaUrl?: string;
  buttons?: TelegramButtons;
  messageThreadId?: number;
  replyToMessageId?: number;
  quoteText?: string;
}) {
  const replyMarkup = buildTelegramReplyMarkup(params.buttons);
  const replyParams =
    params.replyToMessageId == null
      ? {}
      : params.quoteText
        ? {
            reply_parameters: {
              message_id: Math.trunc(params.replyToMessageId),
              quote: params.quoteText,
            },
          }
        : { reply_to_message_id: Math.trunc(params.replyToMessageId) };
  const baseBody = {
    chat_id: params.to,
    ...(params.messageThreadId != null ? { message_thread_id: params.messageThreadId } : {}),
    ...replyParams,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };
  if (params.mediaUrl) {
    return {
      method: "sendPhoto" as const,
      body: {
        ...baseBody,
        photo: params.mediaUrl,
        ...(params.text ? { caption: params.text, parse_mode: "HTML" as const } : {}),
      },
    };
  }
  return {
    method: "sendMessage" as const,
    body: {
      ...baseBody,
      text: params.text,
      parse_mode: "HTML" as const,
    },
  };
}

export function buildTelegramRawEditMessageText(params: {
  messageId: number;
  text: string;
  buttons?: TelegramButtons;
}) {
  const replyMarkup = buildTelegramReplyMarkup(params.buttons);
  return {
    method: "editMessageText" as const,
    body: {
      message_id: params.messageId,
      text: params.text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    },
  };
}

export function buildDiscordRawSend(params: {
  text: string;
  mediaUrl?: string;
  replyToId?: string | null;
}) {
  return {
    send: {
      text: params.text,
      ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
      ...(params.replyToId ? { replyTo: params.replyToId } : {}),
    },
  };
}

export function buildWhatsAppRawSend(params: {
  text: string;
  mediaUrl?: string;
  gifPlayback?: boolean;
}) {
  return {
    send: {
      text: params.text,
      ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
      ...(params.gifPlayback ? { gifPlayback: true } : {}),
    },
  };
}

export function buildTelegramInboundEnvelope(params: {
  updateId: number;
  sessionKey: string;
  accountId: string;
  rawBody: string;
  fromId: string;
  chatId: string;
  topicId?: number;
  chatType: "direct" | "group";
  messageId: string;
  timestampMs: number;
  routeKey: string;
  rawMessage: unknown;
  rawUpdate: unknown;
  media: unknown;
  attachments: MuxInboundAttachment[];
}): MuxInboundEnvelope {
  const raw = {
    update: params.rawUpdate,
    message: params.rawMessage,
  };
  const payload: MuxInboundEnvelope = {
    eventId: `tg:${params.updateId}`,
    channel: "telegram",
    event: {
      kind: "message",
      raw,
    },
    raw,
    sessionKey: params.sessionKey,
    body: params.rawBody,
    from: `telegram:${params.fromId}`,
    to: `telegram:${params.chatId}`,
    accountId: params.accountId,
    chatType: params.chatType,
    messageId: params.messageId,
    timestampMs: params.timestampMs,
    ...(typeof params.topicId === "number" ? { threadId: params.topicId } : {}),
    channelData: {
      accountId: params.accountId,
      messageId: params.messageId,
      chatId: params.chatId,
      topicId: params.topicId ?? null,
      routeKey: params.routeKey,
      updateId: params.updateId,
      telegram: {
        media: params.media,
        rawMessage: params.rawMessage,
        rawUpdate: params.rawUpdate,
      },
    },
  };
  if (params.attachments.length > 0) {
    payload.attachments = params.attachments;
  }
  return payload;
}

export function buildTelegramCallbackInboundEnvelope(params: {
  updateId: number;
  sessionKey: string;
  accountId: string;
  rawBody: string;
  fromId: string;
  chatId: string;
  topicId?: number;
  chatType: "direct" | "group";
  messageId: string;
  timestampMs: number;
  routeKey: string;
  callbackData: string;
  callbackQueryId?: string;
  rawCallbackQuery: unknown;
  rawMessage: unknown;
  rawUpdate: unknown;
}): MuxInboundEnvelope {
  const raw = {
    update: params.rawUpdate,
    callbackQuery: params.rawCallbackQuery,
    message: params.rawMessage,
  };
  return {
    eventId: `tgcb:${params.updateId}`,
    channel: "telegram",
    event: {
      kind: "callback",
      raw,
    },
    raw,
    sessionKey: params.sessionKey,
    body: params.rawBody,
    from: `telegram:${params.fromId}`,
    to: `telegram:${params.chatId}`,
    accountId: params.accountId,
    chatType: params.chatType,
    messageId: params.messageId,
    timestampMs: params.timestampMs,
    ...(typeof params.topicId === "number" ? { threadId: params.topicId } : {}),
    channelData: {
      accountId: params.accountId,
      messageId: params.messageId,
      chatId: params.chatId,
      topicId: params.topicId ?? null,
      routeKey: params.routeKey,
      updateId: params.updateId,
      telegram: {
        callbackData: params.callbackData,
        callbackQueryId: params.callbackQueryId,
        callbackMessageId: params.messageId,
        rawCallbackQuery: params.rawCallbackQuery,
        rawMessage: params.rawMessage,
        rawUpdate: params.rawUpdate,
      },
    },
  };
}

export function buildDiscordInboundEnvelope(params: {
  messageId: string;
  sessionKey: string;
  accountId: string;
  rawBody: string;
  fromId: string;
  channelId: string;
  guildId: string | null;
  routeKey: string;
  chatType: "direct" | "group";
  timestampMs: number;
  threadId?: string;
  rawMessage: unknown;
  media: unknown;
  attachments: MuxInboundAttachment[];
}): MuxInboundEnvelope {
  const raw = {
    message: params.rawMessage,
  };
  const payload: MuxInboundEnvelope = {
    eventId: `dc:${params.messageId}`,
    channel: "discord",
    event: {
      kind: "message",
      raw,
    },
    raw,
    sessionKey: params.sessionKey,
    body: params.rawBody,
    from: `discord:${params.fromId}`,
    to: `channel:${params.channelId}`,
    accountId: params.accountId,
    chatType: params.chatType,
    messageId: params.messageId,
    timestampMs: params.timestampMs,
    ...(params.threadId ? { threadId: params.threadId } : {}),
    channelData: {
      accountId: params.accountId,
      messageId: params.messageId,
      channelId: params.channelId,
      guildId: params.guildId,
      routeKey: params.routeKey,
      discord: {
        media: params.media,
        rawMessage: params.rawMessage,
      },
    },
  };
  if (params.attachments.length > 0) {
    payload.attachments = params.attachments;
  }
  return payload;
}

export function buildWhatsAppInboundEnvelope(params: {
  messageId: string;
  sessionKey: string;
  openclawAccountId: string;
  rawBody: string;
  fromId: string;
  chatJid: string;
  routeKey: string;
  accountId: string;
  chatType: "direct" | "group";
  timestampMs: number;
  rawMessage: unknown;
  media: unknown;
  attachments: MuxInboundAttachment[];
}): MuxInboundEnvelope {
  const raw = {
    message: params.rawMessage,
  };
  const payload: MuxInboundEnvelope = {
    eventId: `wa:${params.messageId}`,
    channel: "whatsapp",
    event: {
      kind: "message",
      raw,
    },
    raw,
    sessionKey: params.sessionKey,
    body: params.rawBody,
    from: `whatsapp:${params.fromId}`,
    to: `whatsapp:${params.chatJid}`,
    accountId: params.openclawAccountId,
    chatType: params.chatType,
    messageId: params.messageId,
    timestampMs: params.timestampMs,
    channelData: {
      accountId: params.accountId,
      messageId: params.messageId,
      chatJid: params.chatJid,
      routeKey: params.routeKey,
      whatsapp: {
        media: params.media,
        rawMessage: params.rawMessage,
      },
    },
  };
  if (params.attachments.length > 0) {
    payload.attachments = params.attachments;
  }
  return payload;
}
