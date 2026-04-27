import type { Message, UserFromGetMe } from "@grammyjs/types";
import {
  listChatCommands,
  maybeResolveTextAlias,
  normalizeCommandBody,
} from "openclaw/plugin-sdk/command-auth";
import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/infra-runtime";
import { resolveTelegramForumThreadId } from "./bot/helpers.js";

export type TelegramSequentialKeyContext = {
  chat?: { id?: number };
  me?: UserFromGetMe;
  message?: Message;
  channelPost?: Message;
  editedChannelPost?: Message;
  update?: {
    message?: Message;
    edited_message?: Message;
    channel_post?: Message;
    edited_channel_post?: Message;
    callback_query?: { message?: Message; data?: string };
    message_reaction?: { chat?: { id?: number } };
  };
};

function resolveControlCommand(
  params: { rawText?: string; botUsername?: string },
  predicate: (command: { key: string; category?: string }) => boolean,
): boolean {
  const normalizedBody = normalizeCommandBody(
    params.rawText?.trim() ?? "",
    params.botUsername ? { botUsername: params.botUsername } : undefined,
  );
  const alias = maybeResolveTextAlias(normalizedBody);
  if (!alias) {
    return false;
  }
  const command = listChatCommands().find((entry) =>
    entry.textAliases.some((candidate) => candidate.trim().toLowerCase() === alias),
  );
  return command ? predicate(command) : false;
}

function resolveStatusCommandControlLane(params: {
  rawText?: string;
  botUsername?: string;
}): boolean {
  // Only read-only status commands should bypass the per-topic lane. Commands
  // like /export-session stay on the normal lane because they materialize
  // session state to disk and should not interleave with an active turn.
  return resolveControlCommand(params, (cmd) =>
    cmd.category === "status" && cmd.key !== "export-session",
  );
}

function resolveSessionControlCommand(params: {
  rawText?: string;
  botUsername?: string;
}): boolean {
  // Session lifecycle commands (/new, /reset) must bypass the per-topic
  // sequential queue so they execute immediately even when an agent run is active.
  // Without this, these commands get queued behind the running turn and never
  // actually reset the session.
  return resolveControlCommand(params, (cmd) =>
    cmd.key === "new" || cmd.key === "reset",
  );
}

export function getTelegramSequentialKey(ctx: TelegramSequentialKeyContext): string {
  const reaction = ctx.update?.message_reaction;
  if (reaction?.chat?.id) {
    return `telegram:${reaction.chat.id}`;
  }
  const msg =
    ctx.message ??
    ctx.channelPost ??
    ctx.editedChannelPost ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.update?.channel_post ??
    ctx.update?.edited_channel_post ??
    ctx.update?.callback_query?.message;
  const chatId = msg?.chat?.id ?? ctx.chat?.id;
  const rawText = msg?.text ?? msg?.caption;
  const botUsername = ctx.me?.username;
  if (isAbortRequestText(rawText, botUsername ? { botUsername } : undefined)) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:control`;
    }
    return "telegram:control";
  }
  if (resolveStatusCommandControlLane({ rawText, botUsername })) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:control`;
    }
    return "telegram:control";
  }
  if (resolveSessionControlCommand({ rawText, botUsername })) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:control`;
    }
    return "telegram:control";
  }
  if (isBtwRequestText(rawText, botUsername ? { botUsername } : undefined)) {
    const messageId = msg?.message_id;
    if (typeof chatId === "number" && typeof messageId === "number") {
      return `telegram:${chatId}:btw:${messageId}`;
    }
    if (typeof chatId === "number") {
      return `telegram:${chatId}:btw`;
    }
    return "telegram:btw";
  }
  const callbackData = ctx.update?.callback_query?.data;
  if (callbackData && parseExecApprovalCommandText(callbackData) !== null) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:approval`;
    }
    return "telegram:approval";
  }
  const isGroup = msg?.chat?.type === "group" || msg?.chat?.type === "supergroup";
  const messageThreadId = msg?.message_thread_id;
  const isForum = msg?.chat?.is_forum;
  const threadId = isGroup
    ? resolveTelegramForumThreadId({ isForum, messageThreadId })
    : messageThreadId;
  if (typeof chatId === "number") {
    return threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
  }
  return "telegram:unknown";
}
