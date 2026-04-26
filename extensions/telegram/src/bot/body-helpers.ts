import type { Chat, Message, MessageOrigin, User } from "@grammyjs/types";
import type { NormalizedLocation } from "openclaw/plugin-sdk/channel-inbound";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";

type TelegramMediaMessage = Pick<
  Message,
  "photo" | "video" | "video_note" | "audio" | "voice" | "document" | "sticker"
>;

type TelegramMediaFileRef =
  | NonNullable<Message["photo"]>[number]
  | NonNullable<Message["video"]>
  | NonNullable<Message["video_note"]>
  | NonNullable<Message["audio"]>
  | NonNullable<Message["voice"]>
  | NonNullable<Message["document"]>
  | NonNullable<Message["sticker"]>;

export type TelegramPrimaryMedia = {
  placeholder: string;
  fileRef: TelegramMediaFileRef;
};

export function buildSenderName(msg: Message) {
  const name =
    [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim() ||
    msg.from?.username;
  return name || undefined;
}

export function resolveTelegramPrimaryMedia(
  msg: TelegramMediaMessage | undefined | null,
): TelegramPrimaryMedia | undefined {
  if (!msg) {
    return undefined;
  }
  const photo = msg.photo?.[msg.photo.length - 1];
  if (photo) {
    return { placeholder: "<media:image>", fileRef: photo };
  }
  if (msg.video) {
    return { placeholder: "<media:video>", fileRef: msg.video };
  }
  if (msg.video_note) {
    return { placeholder: "<media:video>", fileRef: msg.video_note };
  }
  if (msg.audio) {
    return { placeholder: "<media:audio>", fileRef: msg.audio };
  }
  if (msg.voice) {
    return { placeholder: "<media:audio>", fileRef: msg.voice };
  }
  if (msg.document) {
    return { placeholder: "<media:document>", fileRef: msg.document };
  }
  if (msg.sticker) {
    return { placeholder: "<media:sticker>", fileRef: msg.sticker };
  }
  return undefined;
}

export function resolveTelegramMediaPlaceholder(
  msg: TelegramMediaMessage | undefined | null,
): string | undefined {
  return resolveTelegramPrimaryMedia(msg)?.placeholder;
}

export function buildSenderLabel(msg: Message, senderId?: number | string) {
  const name = buildSenderName(msg);
  const username = msg.from?.username ? `@${msg.from.username}` : undefined;
  let label = name;
  if (name && username) {
    label = `${name} (${username})`;
  } else if (!name && username) {
    label = username;
  }
  const normalizedSenderId =
    senderId != null ? normalizeOptionalString(String(senderId)) : undefined;
  const fallbackId = normalizedSenderId ?? (msg.from?.id != null ? String(msg.from.id) : undefined);
  const idPart = fallbackId ? `id:${fallbackId}` : undefined;
  if (label && idPart) {
    return `${label} ${idPart}`;
  }
  if (label) {
    return label;
  }
  return idPart ?? "id:unknown";
}

export type TelegramTextEntity = NonNullable<Message["entities"]>[number];

export function isBinaryContent(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return true;
    }
  }
  return false;
}

export function resolveTelegramTextContent(text: unknown, caption?: unknown): string {
  const raw = typeof text === "string" ? text : typeof caption === "string" ? caption : "";
  return isBinaryContent(raw) ? "" : raw;
}

export function getTelegramTextParts(
  msg: Pick<Message, "text" | "caption" | "entities" | "caption_entities">,
): {
  text: string;
  entities: TelegramTextEntity[];
} {
  const text = resolveTelegramTextContent(msg.text, msg.caption);
  const entities = text ? (msg.entities ?? msg.caption_entities ?? []) : [];
  return { text, entities };
}

function isTelegramMentionWordChar(char: string | undefined): boolean {
  return char != null && /[a-z0-9_]/i.test(char);
}

function hasStandaloneTelegramMention(text: string, mention: string): boolean {
  let startIndex = 0;
  while (startIndex < text.length) {
    const idx = text.indexOf(mention, startIndex);
    if (idx === -1) {
      return false;
    }
    const prev = idx > 0 ? text[idx - 1] : undefined;
    const next = text[idx + mention.length];
    if (!isTelegramMentionWordChar(prev) && !isTelegramMentionWordChar(next)) {
      return true;
    }
    startIndex = idx + 1;
  }
  return false;
}

export function hasBotMention(msg: Message, botUsername: string) {
  const { text, entities } = getTelegramTextParts(msg);
  const mention = normalizeLowercaseStringOrEmpty(`@${botUsername}`);
  if (hasStandaloneTelegramMention(normalizeLowercaseStringOrEmpty(text), mention)) {
    return true;
  }
  for (const ent of entities) {
    if (ent.type !== "mention") {
      continue;
    }
    const slice = text.slice(ent.offset, ent.offset + ent.length);
    if (normalizeLowercaseStringOrEmpty(slice) === mention) {
      return true;
    }
  }
  return false;
}

type TelegramTextLinkEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
};

export function expandTextLinks(text: string, entities?: TelegramTextLinkEntity[] | null): string {
  if (!text || !entities?.length) {
    return text;
  }

  const textLinks = entities
    .filter(
      (entity): entity is TelegramTextLinkEntity & { url: string } =>
        entity.type === "text_link" && Boolean(entity.url),
    )
    .toSorted((a, b) => b.offset - a.offset);

  if (textLinks.length === 0) {
    return text;
  }

  let result = text;
  for (const entity of textLinks) {
    const linkText = text.slice(entity.offset, entity.offset + entity.length);
    const markdown = `[${linkText}](${entity.url})`;
    result =
      result.slice(0, entity.offset) + markdown + result.slice(entity.offset + entity.length);
  }
  return result;
}

export type TelegramForwardedContext = {
  from: string;
  date?: number;
  fromType: string;
  fromId?: string;
  fromUsername?: string;
  fromTitle?: string;
  fromSignature?: string;
  fromChatType?: Chat["type"];
  fromMessageId?: number;
};

function normalizeForwardedUserLabel(user: User) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  const username = normalizeOptionalString(user.username);
  const id = String(user.id);
  const display =
    (name && username
      ? `${name} (@${username})`
      : name || (username ? `@${username}` : undefined)) || `user:${id}`;
  return { display, name: name || undefined, username, id };
}

function normalizeForwardedChatLabel(chat: Chat, fallbackKind: "chat" | "channel") {
  const title = normalizeOptionalString(chat.title);
  const username = normalizeOptionalString(chat.username);
  const id = String(chat.id);
  const display = title || (username ? `@${username}` : undefined) || `${fallbackKind}:${id}`;
  return { display, title, username, id };
}

function buildForwardedContextFromUser(params: {
  user: User;
  date?: number;
  type: string;
}): TelegramForwardedContext | null {
  const { display, name, username, id } = normalizeForwardedUserLabel(params.user);
  if (!display) {
    return null;
  }
  return {
    from: display,
    date: params.date,
    fromType: params.type,
    fromId: id,
    fromUsername: username,
    fromTitle: name,
  };
}

function buildForwardedContextFromHiddenName(params: {
  name?: string;
  date?: number;
  type: string;
}): TelegramForwardedContext | null {
  const trimmed = params.name?.trim();
  if (!trimmed) {
    return null;
  }
  return {
    from: trimmed,
    date: params.date,
    fromType: params.type,
    fromTitle: trimmed,
  };
}

function buildForwardedContextFromChat(params: {
  chat: Chat;
  date?: number;
  type: string;
  signature?: string;
  messageId?: number;
}): TelegramForwardedContext | null {
  const fallbackKind = params.type === "channel" ? "channel" : "chat";
  const { display, title, username, id } = normalizeForwardedChatLabel(params.chat, fallbackKind);
  if (!display) {
    return null;
  }
  const signature = normalizeOptionalString(params.signature);
  const from = signature ? `${display} (${signature})` : display;
  const chatType = normalizeOptionalString(params.chat.type) as Chat["type"] | undefined;
  return {
    from,
    date: params.date,
    fromType: params.type,
    fromId: id,
    fromUsername: username,
    fromTitle: title,
    fromSignature: signature,
    fromChatType: chatType,
    fromMessageId: params.messageId,
  };
}

function resolveForwardOrigin(origin: MessageOrigin): TelegramForwardedContext | null {
  switch (origin.type) {
    case "user":
      return buildForwardedContextFromUser({
        user: origin.sender_user,
        date: origin.date,
        type: "user",
      });
    case "hidden_user":
      return buildForwardedContextFromHiddenName({
        name: origin.sender_user_name,
        date: origin.date,
        type: "hidden_user",
      });
    case "chat":
      return buildForwardedContextFromChat({
        chat: origin.sender_chat,
        date: origin.date,
        type: "chat",
        signature: origin.author_signature,
      });
    case "channel":
      return buildForwardedContextFromChat({
        chat: origin.chat,
        date: origin.date,
        type: "channel",
        signature: origin.author_signature,
        messageId: origin.message_id,
      });
    default:
      origin satisfies never;
      return null;
  }
}

export function normalizeForwardedContext(msg: Message): TelegramForwardedContext | null {
  if (!msg.forward_origin) {
    return null;
  }
  return resolveForwardOrigin(msg.forward_origin);
}

export function extractTelegramLocation(msg: Message): NormalizedLocation | null {
  const { venue, location } = msg;

  if (venue) {
    return {
      latitude: venue.location.latitude,
      longitude: venue.location.longitude,
      accuracy: venue.location.horizontal_accuracy,
      name: venue.title,
      address: venue.address,
      source: "place",
      isLive: false,
    };
  }

  if (location) {
    const isLive = typeof location.live_period === "number" && location.live_period > 0;
    return {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.horizontal_accuracy,
      source: isLive ? "live" : "pin",
      isLive,
    };
  }

  return null;
}

/**
 * Detect bot-targeting metadata for a Telegram inbound message.
 *
 * - `mentionedBot`: lowercased username (no `@`) of a bot mentioned in this
 *   message; `null` if we can definitively say no bot was mentioned;
 *   `undefined` if we can't tell (no current-bot username configured and
 *   no other-bot list to check against).
 * - `repliedToBot`: lowercased username of the bot whose message this is a
 *   reply to (via `reply_to_message.from`), `null` if the reply target was
 *   explicitly a non-bot, `undefined` if there's no reply target at all.
 *
 * `currentBotUsername` is the running bot's `@me` username (lowercased,
 * already trimmed of `@`). `otherBotUsernames` are other known bots in the
 * group (same format) — when supplied we also detect mentions of them in
 * the message text/entities.
 */
export function detectTelegramBotTargeting(
  msg: Pick<Message, "text" | "caption" | "entities" | "caption_entities" | "reply_to_message">,
  params: {
    currentBotUsername?: string;
    otherBotUsernames?: readonly string[];
  },
): { mentionedBot?: string | null; repliedToBot?: string | null } {
  const { currentBotUsername, otherBotUsernames } = params;
  const knownBots = new Set<string>();
  if (currentBotUsername) {
    knownBots.add(currentBotUsername.toLowerCase());
  }
  for (const other of otherBotUsernames ?? []) {
    const normalized = other.trim().toLowerCase();
    if (normalized) {
      knownBots.add(normalized);
    }
  }

  const result: { mentionedBot?: string | null; repliedToBot?: string | null } = {};

  if (knownBots.size > 0) {
    const { text, entities } = getTelegramTextParts(msg);
    let found: string | null = null;
    if (text) {
      for (const ent of entities) {
        if (ent.type !== "mention") {
          continue;
        }
        const slice = text.slice(ent.offset, ent.offset + ent.length);
        const candidate = normalizeLowercaseStringOrEmpty(slice).replace(/^@/, "");
        if (candidate && knownBots.has(candidate)) {
          found = candidate;
          break;
        }
      }
      if (!found) {
        const lowered = normalizeLowercaseStringOrEmpty(text);
        for (const bot of knownBots) {
          if (hasStandaloneTelegramMention(lowered, `@${bot}`)) {
            found = bot;
            break;
          }
        }
      }
    }
    result.mentionedBot = found;
  }

  const reply = msg.reply_to_message;
  if (reply !== undefined) {
    const replyFrom = reply.from;
    if (replyFrom?.is_bot && replyFrom.username) {
      result.repliedToBot = replyFrom.username.toLowerCase();
    } else if (replyFrom != null) {
      result.repliedToBot = null;
    }
  }

  return result;
}
