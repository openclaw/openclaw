import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { assertAllowedJinheeWrite } from "./jinhee-db-write-guard.js";

export type JinheeConversationLogEntry = {
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  source: "telegram_openclaw";
  messageId?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
};

export const DEFAULT_JINHEE_DB_PATH = "/home/savit/ai/jinhee_data/jinhee.db";
export const DEFAULT_BUSY_TIMEOUT_MS = 800;
export const DEFAULT_MAX_TEXT_CHARS = 4000;

type JinheeConversationLogWriterOptions = {
  dbPath?: string;
  maxTextChars?: number;
  timeoutMs?: number;
  allowOperationalDb?: boolean;
};

type ConversationLogColumn = {
  name: string;
};

const SECRET_LINE_PATTERN =
  /\b(?:token|api_key|secret|password|refresh_token|authorization|bearer|client_secret|access_token)\b/iu;

function redactSecretLines(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => (SECRET_LINE_PATTERN.test(line) ? "[REDACTED]" : line))
    .join("\n");
}

function truncateText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function sanitizeContent(content: string, maxChars: number): string {
  return truncateText(redactSecretLines(content), maxChars);
}

function sanitizeMetadataValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecretLines(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadataValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SECRET_LINE_PATTERN.test(key) ? "[REDACTED]" : sanitizeMetadataValue(entry),
    ]),
  );
}

function sanitizeMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) {
    return undefined;
  }
  return JSON.stringify(sanitizeMetadataValue(metadata));
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteValue(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function resolveColumn(columns: Set<string>, names: readonly string[]): string | undefined {
  return names.find((name) => columns.has(name));
}

function generateMessageId(entry: JinheeConversationLogEntry): string {
  if (entry.messageId) {
    return `${entry.sessionId}:${entry.messageId}`;
  }
  const rand = Math.random().toString(36).slice(2, 8);
  return `${entry.sessionId}:oc:${Date.now()}_${rand}`;
}

function buildInsertSql(params: {
  columns: Set<string>;
  entry: JinheeConversationLogEntry;
  content: string;
  metadataJson?: string;
}): string | undefined {
  // Required columns: sender, sender_type, text (mapped from sessionId/role/content)
  const senderColumn = resolveColumn(params.columns, ["sender"]);
  const senderTypeColumn = resolveColumn(params.columns, ["sender_type"]);
  const textColumn = resolveColumn(params.columns, ["text"]);

  if (!senderColumn || !senderTypeColumn || !textColumn) {
    return undefined;
  }

  const insertValues = new Map<string, string>([
    ["channel", "telegram"],
    ["message_id", generateMessageId(params.entry)],
    [senderColumn, params.entry.sessionId],
    [senderTypeColumn, params.entry.role],
    [textColumn, params.content],
    ["category", "inbound"],
    ["is_bot_response", params.entry.role === "assistant" ? "1" : "0"],
  ]);

  // Optional: raw_payload_json (metadata)
  const rawPayloadColumn = resolveColumn(params.columns, ["raw_payload_json"]);
  if (rawPayloadColumn && params.metadataJson !== undefined) {
    insertValues.set(rawPayloadColumn, params.metadataJson);
  }

  // Optional: received_at
  const receivedAtColumn = resolveColumn(params.columns, ["received_at"]);
  if (receivedAtColumn) {
    insertValues.set(receivedAtColumn, params.entry.createdAt ?? new Date().toISOString());
  }

  const columnSql = Array.from(insertValues.keys()).map(quoteIdentifier).join(", ");
  const valueSql = Array.from(insertValues.values()).map(quoteValue).join(", ");
  return `INSERT INTO conversation_logs (${columnSql}) VALUES (${valueSql})`;
}

function warnJinheeLogFailure(reason: string): void {
  console.warn(`jinhee conversation log append failed: ${reason}`);
}

export async function appendJinheeConversationLog(
  entry: JinheeConversationLogEntry,
  options?: JinheeConversationLogWriterOptions,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const dbPath = options?.dbPath ?? DEFAULT_JINHEE_DB_PATH;
  if (dbPath === DEFAULT_JINHEE_DB_PATH) {
    if (process.env.NODE_ENV === "test") {
      return { ok: false, reason: "operational db disabled in tests" };
    }
    if (options?.allowOperationalDb !== true) {
      return { ok: false, reason: "operational db write not enabled" };
    }
  }
  if (!existsSync(dbPath)) {
    return { ok: false, reason: "db file not found" };
  }

  let db: DatabaseSync | undefined;
  try {
    const { DatabaseSync } = requireNodeSqlite();
    db = new DatabaseSync(dbPath);
    const timeoutMs = options?.timeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(timeoutMs))}`);
    const rows = db
      .prepare("PRAGMA table_info(conversation_logs)")
      .all() as ConversationLogColumn[];
    const columns = new Set(rows.map((row) => row.name).filter((name) => typeof name === "string"));
    if (columns.size === 0) {
      return { ok: false, reason: "conversation_logs table not found" };
    }
    const sql = buildInsertSql({
      columns,
      entry,
      content: sanitizeContent(entry.content, options?.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS),
      metadataJson: sanitizeMetadata(entry.metadata),
    });
    if (!sql) {
      return { ok: false, reason: "conversation_logs schema is unsupported" };
    }
    assertAllowedJinheeWrite(sql);
    db.exec(sql);
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnJinheeLogFailure(reason);
    return { ok: false, reason };
  } finally {
    db?.close();
  }
}
