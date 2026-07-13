// Imessage plugin module binds provider message ids to one authorized chat.
import { createRequire } from "node:module";
import { createActionGate } from "openclaw/plugin-sdk/channel-actions";
import type { ResolvedIMessageAccount } from "./accounts.js";
import { chatContextFromIMessageTarget } from "./chat-context.js";
import { resolveLocalIMessageChatDbPath } from "./cli-path.js";
import {
  resolveIMessageCachedResourceBinding,
  resolveIMessageMessageId,
  type IMessageChatContext,
} from "./monitor-reply-cache.js";
import type { IMessageService, IMessageTarget } from "./targets.js";

const require = createRequire(import.meta.url);
const MAX_REPLY_TO_ID_LENGTH = 256;

export type IMessageResourceBinding = "match" | "mismatch" | "unavailable";
export { resolveIMessageCachedResourceBinding };

type IMessageResourceAuthorizationParams = {
  accountId: string;
  chatContext: IMessageChatContext;
  cliPath: string;
  dbPath?: string;
  hasExclusiveLocalDatabase: boolean;
  remoteHost?: string;
  messageId: string;
  conversationReadOrigin?: string;
};

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

export function resolveAuthorizedIMessageReplyReference(params: {
  account: ResolvedIMessageAccount;
  target: IMessageTarget;
  cliPath: string;
  dbPath?: string;
  hasExclusiveLocalDatabase: boolean;
  service?: IMessageService;
  replyToId?: string;
  conversationReadOrigin?: string;
}): string | undefined {
  if (!createActionGate(params.account.config.actions)("reply")) {
    return undefined;
  }
  const rawReplyToId = sanitizeReplyToId(params.replyToId);
  if (!rawReplyToId) {
    return undefined;
  }
  const chatContext = chatContextFromIMessageTarget(params.target, params.service);
  const messageId = resolveIMessageMessageId(rawReplyToId, {
    requireKnownShortId: true,
    chatContext,
  });
  authorizeIMessageResourceReference({
    accountId: params.account.accountId,
    chatContext,
    cliPath: params.cliPath,
    dbPath: params.dbPath,
    hasExclusiveLocalDatabase: params.hasExclusiveLocalDatabase,
    remoteHost: params.account.config.remoteHost,
    messageId,
    conversationReadOrigin: params.conversationReadOrigin,
  });
  return messageId;
}

function normalizeMessageGuidForLookup(messageId: string): string {
  const trimmed = messageId.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 && slash + 1 < trimmed.length ? trimmed.slice(slash + 1) : trimmed;
}

function chatGuidCandidates(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return [];
  }
  const ordered = [trimmed];
  const parts = trimmed.split(";");
  const service = parts[0]?.toLowerCase();
  const kind = parts[1];
  const identifier = parts[2];
  if (parts.length === 3 && (kind === "+" || kind === "-") && identifier) {
    if (service === "any") {
      ordered.push(`iMessage;${kind};${identifier}`, `SMS;${kind};${identifier}`);
    } else if (service === "imessage") {
      ordered.push(`iMessage;${kind};${identifier}`, `any;${kind};${identifier}`);
    } else if (service === "sms") {
      ordered.push(`SMS;${kind};${identifier}`, `any;${kind};${identifier}`);
    }
  }
  return [...new Set(ordered)];
}

function chatIdentifierCandidates(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return [];
  }
  const parts = trimmed.split(";");
  const service = parts[0]?.toLowerCase();
  const hasKnownPrefix = service === "imessage" || service === "sms" || service === "any";
  const hasKnownKind = parts[1] === "+" || parts[1] === "-";
  const bareIdentifier =
    parts.length === 3 && hasKnownPrefix && hasKnownKind ? parts[2] : undefined;
  return [...new Set([trimmed, ...(bareIdentifier ? [bareIdentifier] : [])])];
}

function isKnownChatGuid(raw: string | undefined): raw is string {
  const parts = raw?.trim().split(";");
  if (!parts || parts.length !== 3 || (parts[1] !== "+" && parts[1] !== "-") || !parts[2]) {
    return false;
  }
  const service = parts[0]?.toLowerCase();
  return service === "imessage" || service === "sms" || service === "any";
}

function loadNodeSqlite(): typeof import("node:sqlite") | null {
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch {
    return null;
  }
}

export function checkIMessageResourceBinding(
  params: Omit<
    IMessageResourceAuthorizationParams,
    "accountId" | "conversationReadOrigin" | "hasExclusiveLocalDatabase"
  >,
): IMessageResourceBinding {
  const dbPath = resolveLocalIMessageChatDbPath(params);
  const sqlite = loadNodeSqlite();
  if (!dbPath || !sqlite) {
    return "unavailable";
  }
  const messageGuid = normalizeMessageGuidForLookup(params.messageId);
  if (!messageGuid) {
    return "mismatch";
  }
  const expectedChatGuids = chatGuidCandidates(params.chatContext.chatGuid);
  const expectedChatIdentifiers = chatIdentifierCandidates(params.chatContext.chatIdentifier);
  const identifierChatGuids = isKnownChatGuid(params.chatContext.chatIdentifier)
    ? chatGuidCandidates(params.chatContext.chatIdentifier)
    : [];
  const chatId = params.chatContext.chatId;
  const chatClauses: string[] = [];
  const bindings: Array<string | number> = [messageGuid];
  if (typeof chatId === "number" && Number.isSafeInteger(chatId) && chatId > 0) {
    chatClauses.push("cmj.chat_id = ?");
    bindings.push(chatId);
  }
  if (expectedChatGuids.length > 0) {
    chatClauses.push(`c.guid IN (${expectedChatGuids.map(() => "?").join(", ")})`);
    bindings.push(...expectedChatGuids);
  }
  if (expectedChatIdentifiers.length > 0) {
    chatClauses.push(`c.chat_identifier IN (${expectedChatIdentifiers.map(() => "?").join(", ")})`);
    bindings.push(...expectedChatIdentifiers);
  }
  if (identifierChatGuids.length > 0) {
    chatClauses.push(`c.guid IN (${identifierChatGuids.map(() => "?").join(", ")})`);
    bindings.push(...identifierChatGuids);
  }
  if (chatClauses.length === 0) {
    return "unavailable";
  }

  let db: import("node:sqlite").DatabaseSync | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        `SELECT 1 AS found
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         JOIN chat c ON c.ROWID = cmj.chat_id
         WHERE m.guid = ? AND (${chatClauses.join(" AND ")})
         LIMIT 1`,
      )
      .get(...bindings);
    return row ? "match" : "mismatch";
  } catch {
    return "unavailable";
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort cleanup after a read-only authorization query.
    }
  }
}

export function authorizeIMessageResourceReference(
  params: IMessageResourceAuthorizationParams,
): void {
  const cacheContext = {
    ...params.chatContext,
    accountId: params.accountId,
  };
  let cacheBinding = resolveIMessageCachedResourceBinding(params.messageId, cacheContext);
  const normalizedMessageId = normalizeMessageGuidForLookup(params.messageId);
  if (cacheBinding === "unknown" && normalizedMessageId !== params.messageId.trim()) {
    cacheBinding = resolveIMessageCachedResourceBinding(normalizedMessageId, cacheContext);
  }
  if (cacheBinding === "match") {
    return;
  }
  if (cacheBinding === "mismatch") {
    throw new Error("iMessage message reference belongs to a different account or conversation.");
  }

  const providerBinding = params.hasExclusiveLocalDatabase
    ? checkIMessageResourceBinding(params)
    : "unavailable";
  if (providerBinding === "match") {
    return;
  }
  if (providerBinding === "mismatch") {
    throw new Error("iMessage message reference does not belong to the selected conversation.");
  }
  if (params.conversationReadOrigin === "direct-operator") {
    return;
  }
  throw new Error(
    "Delegated iMessage message references require a current same-account conversation binding when the Messages database is unavailable.",
  );
}
