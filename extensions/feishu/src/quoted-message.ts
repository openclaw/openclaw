import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { getLiveSessionTranscriptEntries } from "../../../src/agents/pi-embedded-runner/live-session-registry.js";
import {
  loadSessionStore,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
  type SessionTranscriptMessageMeta,
} from "../../../src/config/sessions.js";
import { stripEnvelopeFromMessage } from "../../../src/gateway/chat-sanitize.js";
import { resolveUserPath } from "../../../src/utils.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu, type FeishuMessageInfo } from "./send.js";

type QuotedMessageSource = "session" | "db" | "api";

export type ResolvedQuotedFeishuMessage = {
  content?: string;
  source?: QuotedMessageSource;
};

type FetchQuotedMessage = (params: {
  cfg: ClawdbotConfig;
  messageId: string;
  accountId?: string;
}) => Promise<FeishuMessageInfo | null>;

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function extractMessageText(message: Record<string, unknown>): string | undefined {
  const directContent = toNonEmptyString(message.content);
  if (directContent) {
    return directContent;
  }
  if (Array.isArray(message.content)) {
    const parts = message.content
      .map((item) => {
        if (!item || typeof item !== "object") {
          return undefined;
        }
        const record = item as Record<string, unknown>;
        if (
          record.type !== "text" &&
          record.type !== "input_text" &&
          record.type !== "output_text"
        ) {
          return undefined;
        }
        return toNonEmptyString(record.text);
      })
      .filter((value): value is string => Boolean(value));
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return toNonEmptyString(message.text);
}

function extractSanitizedMessageText(message: Record<string, unknown>): string | undefined {
  const sanitized = stripEnvelopeFromMessage(message);
  if (!sanitized || typeof sanitized !== "object") {
    return undefined;
  }
  return extractMessageText(sanitized as Record<string, unknown>);
}

function extractConversationInfo(text: string): Record<string, unknown> | null {
  const match = text.match(
    /(?:^|\n)Conversation info \(untrusted metadata\):\n```json\n([\s\S]*?)\n```/,
  );
  if (!match?.[1]) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function resolveTranscriptPath(params: {
  storePath: string;
  agentId?: string;
  sessionKey: string;
}): string | undefined {
  const store = loadSessionStore(params.storePath, { skipCache: true });
  const entry = store[params.sessionKey] as SessionEntry | undefined;
  if (!entry?.sessionId) {
    return undefined;
  }
  return resolveSessionFilePath(
    entry.sessionId,
    entry,
    resolveSessionFilePathOptions({
      agentId: params.agentId,
      storePath: params.storePath,
    }),
  );
}

function resolveSessionEntry(params: {
  storePath: string;
  sessionKey: string;
}): SessionEntry | undefined {
  const store = loadSessionStore(params.storePath, { skipCache: true });
  return store[params.sessionKey] as SessionEntry | undefined;
}

function resolveMirroredProviderMessageIds(meta: SessionTranscriptMessageMeta): string[] {
  const ids = new Set<string>();
  const providerMessageId = toNonEmptyString(meta.providerMessageId);
  if (providerMessageId) {
    ids.add(providerMessageId);
  }
  if (Array.isArray(meta.providerMessageIds)) {
    for (const value of meta.providerMessageIds) {
      const id = toNonEmptyString(value);
      if (id) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

function matchesMirroredAssistantMessage(params: {
  meta: SessionTranscriptMessageMeta;
  parentId: string;
  accountId?: string;
  chatId: string;
}): boolean {
  const channel = toNonEmptyString(params.meta.channel)?.toLowerCase();
  if (channel && channel !== "feishu") {
    return false;
  }
  const accountId = toNonEmptyString(params.meta.accountId);
  if (accountId && params.accountId && accountId !== params.accountId) {
    return false;
  }
  const chatId = toNonEmptyString(params.meta.chatId);
  if (chatId && chatId !== params.chatId) {
    return false;
  }
  return resolveMirroredProviderMessageIds(params.meta).includes(params.parentId);
}

function findQuotedContentInEntries(
  entries: unknown[],
  params: {
    parentId: string;
    accountId?: string;
    chatId: string;
  },
): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const parsed = entries[index];
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const entry = parsed as Record<string, unknown>;
    if (entry.type !== "message") {
      continue;
    }
    const message =
      entry.message && typeof entry.message === "object"
        ? (entry.message as Record<string, unknown>)
        : null;
    if (!message) {
      continue;
    }

    const role = toNonEmptyString(message.role)?.toLowerCase();
    if (role === "user") {
      const rawText = extractMessageText(message);
      const conversationInfo = rawText ? extractConversationInfo(rawText) : null;
      if (toNonEmptyString(conversationInfo?.message_id) !== params.parentId) {
        continue;
      }
      return extractSanitizedMessageText(message);
    }

    if (role === "assistant") {
      const meta =
        message.openclawMessageMeta && typeof message.openclawMessageMeta === "object"
          ? (message.openclawMessageMeta as SessionTranscriptMessageMeta)
          : undefined;
      if (
        !meta ||
        !matchesMirroredAssistantMessage({
          meta,
          parentId: params.parentId,
          accountId: params.accountId,
          chatId: params.chatId,
        })
      ) {
        continue;
      }
      return extractSanitizedMessageText(message);
    }
  }

  return undefined;
}

function readQuotedContentFromLiveSession(params: {
  storePath: string;
  sessionKey: string;
  parentId: string;
  accountId?: string;
  chatId: string;
}): string | undefined {
  const sessionEntry = resolveSessionEntry({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
  });
  const entries = getLiveSessionTranscriptEntries({
    sessionKey: params.sessionKey,
    sessionId: sessionEntry?.sessionId,
  });
  if (!entries || entries.length === 0) {
    return undefined;
  }
  return findQuotedContentInEntries(entries, {
    parentId: params.parentId,
    accountId: params.accountId,
    chatId: params.chatId,
  });
}

function readQuotedContentFromSession(params: {
  storePath: string;
  agentId?: string;
  sessionKey: string;
  parentId: string;
  accountId?: string;
  chatId: string;
}): string | undefined {
  const sessionFile = resolveTranscriptPath({
    storePath: params.storePath,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return undefined;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    return undefined;
  }
  if (!raw.trim()) {
    return undefined;
  }

  const entries = raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return findQuotedContentInEntries(entries, {
    parentId: params.parentId,
    accountId: params.accountId,
    chatId: params.chatId,
  });
}

function resolveBotCompanyDbPath(cfg: ClawdbotConfig, override?: string): string | undefined {
  const explicit = toNonEmptyString(override);
  if (explicit) {
    return explicit;
  }
  const entry = cfg.plugins?.entries?.["bot-company"];
  const pluginConfig =
    entry?.config && typeof entry.config === "object"
      ? (entry.config as Record<string, unknown>)
      : undefined;
  const nestedDb =
    pluginConfig?.db && typeof pluginConfig.db === "object"
      ? (pluginConfig.db as Record<string, unknown>)
      : undefined;
  return toNonEmptyString(pluginConfig?.dbPath) ?? toNonEmptyString(nestedDb?.path);
}

function readQuotedContentFromBotCompanyDb(params: {
  cfg: ClawdbotConfig;
  chatId: string;
  parentId: string;
  dbPath?: string;
}): string | undefined {
  const rawDbPath = resolveBotCompanyDbPath(params.cfg, params.dbPath);
  if (!rawDbPath || rawDbPath === ":memory:") {
    return undefined;
  }

  const dbPath = resolveUserPath(rawDbPath);
  if (!dbPath || !fs.existsSync(dbPath)) {
    return undefined;
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        `SELECT content
         FROM chat_messages
         WHERE chat_id = ? AND message_id = ?
         LIMIT 1`,
      )
      .get(params.chatId, params.parentId) as { content?: unknown } | undefined;
    return toNonEmptyString(row?.content);
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

export async function resolveQuotedFeishuMessageContent(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  agentId?: string;
  sessionKey?: string;
  chatId: string;
  parentId: string;
  isGroup: boolean;
  storePath?: string;
  dbPath?: string;
  fetchMessage?: FetchQuotedMessage;
}): Promise<ResolvedQuotedFeishuMessage> {
  const parentId = toNonEmptyString(params.parentId);
  if (!parentId) {
    return {};
  }

  const fetchMessage = params.fetchMessage ?? getMessageFeishu;

  if (!params.isGroup) {
    const sessionKey = toNonEmptyString(params.sessionKey);
    const storePath =
      toNonEmptyString(params.storePath) ??
      (sessionKey
        ? getFeishuRuntime().channel.session.resolveStorePath(params.cfg.session?.store, {
            agentId: params.agentId,
          })
        : undefined);

    if (storePath && sessionKey) {
      const liveSessionContent = readQuotedContentFromLiveSession({
        storePath,
        sessionKey,
        parentId,
        accountId: params.accountId,
        chatId: params.chatId,
      });
      if (liveSessionContent) {
        return { content: liveSessionContent, source: "session" };
      }

      const sessionContent = readQuotedContentFromSession({
        storePath,
        agentId: params.agentId,
        sessionKey,
        parentId,
        accountId: params.accountId,
        chatId: params.chatId,
      });
      if (sessionContent) {
        return { content: sessionContent, source: "session" };
      }
    }

    const dbContent = readQuotedContentFromBotCompanyDb({
      cfg: params.cfg,
      chatId: params.chatId,
      parentId,
      dbPath: params.dbPath,
    });
    if (dbContent) {
      return { content: dbContent, source: "db" };
    }
  }

  const apiResult = await fetchMessage({
    cfg: params.cfg,
    messageId: parentId,
    accountId: params.accountId,
  });
  const apiContent = toNonEmptyString(apiResult?.content);
  return apiContent ? { content: apiContent, source: "api" } : {};
}
