import { createActionGate } from "openclaw/plugin-sdk/channel-actions";
import type { ResolvedIMessageAccount } from "./accounts.js";
import { chatContextFromIMessageTarget } from "./chat-context.js";
import {
  checkIMessageResourceBinding,
  normalizeIMessageMessageGuidForLookup,
} from "./message-resource-db.js";
import {
  resolveIMessageCachedResourceBinding,
  resolveIMessageMessageId,
  type IMessageChatContext,
} from "./monitor-reply-cache.js";
import type { IMessageService, IMessageTarget } from "./targets.js";

const MAX_REPLY_TO_ID_LENGTH = 256;

function sanitizeReplyToId(rawReplyToId?: string): string | undefined {
  const trimmed = rawReplyToId?.trim();
  if (!trimmed) {
    return undefined;
  }
  let sanitized = "";
  for (const ch of trimmed) {
    const code = ch.charCodeAt(0);
    if ((code >= 0 && code <= 31) || code === 127 || ch === "[" || ch === "]") {
      continue;
    }
    sanitized += ch;
  }
  return sanitized.trim().slice(0, MAX_REPLY_TO_ID_LENGTH) || undefined;
}

export async function resolveAuthorizedIMessageReplyReference(params: {
  account: ResolvedIMessageAccount;
  target: IMessageTarget;
  cliPath: string;
  dbPath?: string;
  remoteHost?: string;
  hasExclusiveLocalDatabase: boolean;
  service?: IMessageService;
  replyToId?: string;
  replyToIdSource?: "explicit" | "implicit";
  conversationReadOrigin?: string;
}): Promise<string | undefined> {
  if (!createActionGate(params.account.config.actions)("reply")) {
    return undefined;
  }
  const rawReplyToId = sanitizeReplyToId(params.replyToId);
  if (!rawReplyToId) {
    return undefined;
  }
  const chatContext = chatContextFromIMessageTarget(params.target, params.service);
  const messageId = await resolveIMessageMessageId(rawReplyToId, {
    chatContext,
  });
  const authorized = await authorizeResourceReference({
    allowMissingImplicitReply: params.replyToIdSource === "implicit",
    accountId: params.account.accountId,
    chatContext,
    cliPath: params.cliPath,
    dbPath: params.dbPath,
    hasExclusiveLocalDatabase: params.hasExclusiveLocalDatabase,
    remoteHost: params.remoteHost ?? params.account.config.remoteHost,
    messageId,
    conversationReadOrigin: params.conversationReadOrigin,
  });
  return authorized ? messageId : undefined;
}

export async function authorizeIMessageResourceReference(params: {
  accountId: string;
  chatContext: IMessageChatContext;
  cliPath: string;
  dbPath?: string;
  remoteHost?: string;
  hasExclusiveLocalDatabase: boolean;
  messageId: string;
  conversationReadOrigin?: string;
}): Promise<void> {
  await authorizeResourceReference(params);
}

async function authorizeResourceReference(
  params: Parameters<typeof authorizeIMessageResourceReference>[0] & {
    allowMissingImplicitReply?: boolean;
  },
): Promise<boolean> {
  const cacheContext = {
    ...params.chatContext,
    accountId: params.accountId,
  };
  let cacheBinding = await resolveIMessageCachedResourceBinding(params.messageId, cacheContext);
  const normalizedMessageId = normalizeIMessageMessageGuidForLookup(params.messageId);
  if (cacheBinding === "unknown" && normalizedMessageId !== params.messageId.trim()) {
    cacheBinding = await resolveIMessageCachedResourceBinding(normalizedMessageId, cacheContext);
  }
  if (cacheBinding === "match") {
    return true;
  }
  if (cacheBinding === "mismatch") {
    throw new Error("iMessage message reference belongs to a different account or conversation.");
  }

  const providerBinding = params.hasExclusiveLocalDatabase
    ? await checkIMessageResourceBinding(params)
    : "unavailable";
  if (providerBinding === "match") {
    return true;
  }
  if (providerBinding === "missing" && params.allowMissingImplicitReply) {
    // Internal session events have IDs but no native message to reply to. Only a
    // successful lookup proving absence may turn an inherited anchor into a root send.
    return false;
  }
  if (providerBinding === "mismatch" || providerBinding === "missing") {
    throw new Error("iMessage message reference does not belong to the selected conversation.");
  }
  if (params.conversationReadOrigin === "direct-operator") {
    return true;
  }
  throw new Error(
    "Delegated iMessage message references require a current same-account conversation binding when the Messages database is unavailable.",
  );
}
