import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendJinheeConversationLog,
  DEFAULT_JINHEE_DB_PATH,
  type JinheeConversationLogEntry,
} from "./jinhee-conversation-log-writer.js";
import { assertAllowedJinheeWrite } from "./jinhee-db-write-guard.js";

type ConversationLogRow = {
  channel: string;
  message_id: string;
  sender: string;
  sender_type: string;
  text: string;
  raw_payload_json: string | null;
  reply_to_message_id: string;
  received_at: string;
  stored_at: string;
  category: string;
  is_bot_response: number;
  processing_status: string;
  error: string | null;
};

const tempRoots: string[] = [];

function makeTempDb(createTable = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-jinhee-log-"));
  tempRoots.push(root);
  const dbPath = path.join(root, "jinhee-test.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    if (createTable) {
      db.exec(`
        CREATE TABLE conversation_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel TEXT NOT NULL DEFAULT 'telegram',
          message_id TEXT NOT NULL,
          sender TEXT,
          sender_type TEXT DEFAULT 'user',
          text TEXT,
          raw_payload_json TEXT,
          reply_to_message_id TEXT DEFAULT '',
          received_at TEXT NOT NULL,
          stored_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
          category TEXT DEFAULT 'inbound',
          is_bot_response INTEGER DEFAULT 0,
          processing_status TEXT DEFAULT 'stored',
          error TEXT,
          UNIQUE(channel, message_id)
        )
      `);
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function readRows(dbPath: string): ConversationLogRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT channel, message_id, sender, sender_type, text, raw_payload_json, reply_to_message_id, received_at, stored_at, category, is_bot_response, processing_status, error FROM conversation_logs ORDER BY id",
      )
      .all() as ConversationLogRow[];
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("appendJinheeConversationLog", () => {
  it("appends successfully to a temp sqlite conversation_logs table", async () => {
    const dbPath = makeTempDb();
    await expect(
      appendJinheeConversationLog(
        {
          sessionId: "chat-1",
          role: "user",
          content: "hello",
          source: "telegram_openclaw",
        },
        { dbPath },
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("stores a user role row", async () => {
    const dbPath = makeTempDb();
    await appendJinheeConversationLog(
      {
        sessionId: "chat-user",
        role: "user",
        content: "user text",
        source: "telegram_openclaw",
      },
      { dbPath },
    );

    const row = readRows(dbPath)[0];
    expect(row.sender).toBe("chat-user");
    expect(row.sender_type).toBe("user");
    expect(row.text).toBe("user text");
    expect(row.channel).toBe("telegram");
    expect(row.category).toBe("inbound");
    expect(row.is_bot_response).toBe(0);
    expect(row.message_id).toMatch(/^chat-user:/);
  });

  it("stores an assistant role row", async () => {
    const dbPath = makeTempDb();
    await appendJinheeConversationLog(
      {
        sessionId: "chat-assistant",
        role: "assistant",
        content: "assistant text",
        source: "telegram_openclaw",
      },
      { dbPath },
    );

    const row = readRows(dbPath)[0];
    expect(row.sender).toBe("chat-assistant");
    expect(row.sender_type).toBe("assistant");
    expect(row.text).toBe("assistant text");
    expect(row.is_bot_response).toBe(1);
  });

  it("truncates text beyond the 4000 character default", async () => {
    const dbPath = makeTempDb();
    await appendJinheeConversationLog(
      {
        sessionId: "chat-long",
        role: "user",
        content: "a".repeat(4100),
        source: "telegram_openclaw",
      },
      { dbPath },
    );

    expect(readRows(dbPath)[0]?.text).toHaveLength(4000);
  });

  it("redacts content lines containing secret keywords", async () => {
    const dbPath = makeTempDb();
    await appendJinheeConversationLog(
      {
        sessionId: "chat-secret",
        role: "user",
        content: "hello\ntoken: abc123\nnext",
        source: "telegram_openclaw",
      },
      { dbPath },
    );

    expect(readRows(dbPath)[0]?.text).toBe("hello\n[REDACTED]\nnext");
  });

  it("stores metadata JSON in raw_payload_json with sensitive keys redacted", async () => {
    const dbPath = makeTempDb();
    await appendJinheeConversationLog(
      {
        sessionId: "chat-metadata",
        role: "system",
        content: "metadata",
        source: "telegram_openclaw",
        metadata: { messageId: 123, password: "raw-secret", nested: { ok: true } },
        createdAt: "2026-06-22T00:00:00.000Z",
      },
      { dbPath },
    );

    const row = readRows(dbPath)[0];
    expect(JSON.parse(row?.raw_payload_json ?? "{}")).toEqual({
      messageId: 123,
      password: "[REDACTED]",
      nested: { ok: true },
    });
  });

  it("stores received_at from createdAt field", async () => {
    const dbPath = makeTempDb();
    await appendJinheeConversationLog(
      {
        sessionId: "chat-time",
        role: "user",
        content: "time test",
        source: "telegram_openclaw",
        createdAt: "2026-06-22T12:00:00.000Z",
      },
      { dbPath },
    );

    expect(readRows(dbPath)[0]?.received_at).toBe("2026-06-22T12:00:00.000Z");
  });

  it("uses provided messageId in message_id column", async () => {
    const dbPath = makeTempDb();
    await appendJinheeConversationLog(
      {
        sessionId: "12345",
        role: "user",
        content: "with msg id",
        source: "telegram_openclaw",
        messageId: "999",
      },
      { dbPath },
    );

    expect(readRows(dbPath)[0]?.message_id).toBe("12345:999");
  });

  it("returns ok:false when the DB file is missing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-jinhee-missing-"));
    tempRoots.push(root);
    const result = await appendJinheeConversationLog(
      {
        sessionId: "chat-missing",
        role: "user",
        content: "missing",
        source: "telegram_openclaw",
      },
      { dbPath: path.join(root, "missing.sqlite") },
    );

    expect(result).toEqual({ ok: false, reason: "db file not found" });
  });

  it("returns ok:false when conversation_logs table is missing", async () => {
    const dbPath = makeTempDb(false);
    const result = await appendJinheeConversationLog(
      {
        sessionId: "chat-no-table",
        role: "user",
        content: "missing table",
        source: "telegram_openclaw",
      },
      { dbPath },
    );

    expect(result).toEqual({ ok: false, reason: "conversation_logs table not found" });
  });

  it("returns ok:false for the operational DB path in NODE_ENV=test", async () => {
    await expect(
      appendJinheeConversationLog(
        {
          sessionId: "chat-prod",
          role: "user",
          content: "must not write",
          source: "telegram_openclaw",
        },
        { dbPath: DEFAULT_JINHEE_DB_PATH, allowOperationalDb: true },
      ),
    ).resolves.toEqual({ ok: false, reason: "operational db disabled in tests" });
  });

  it("keeps the guard blocking canonical_memories inserts", () => {
    expect(() =>
      assertAllowedJinheeWrite("INSERT INTO canonical_memories (content) VALUES ('no')"),
    ).toThrow("Jinhee DB write denied by guard");
  });
});
