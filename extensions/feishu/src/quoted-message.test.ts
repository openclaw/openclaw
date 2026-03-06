import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerLiveSessionTranscript,
  resetLiveSessionTranscriptRegistryForTests,
} from "../../../src/agents/pi-embedded-runner/live-session-registry.js";
import { appendAssistantMessageToSessionTranscript } from "../../../src/config/sessions.js";
import { resolveQuotedFeishuMessageContent } from "./quoted-message.js";

function createSessionFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-feishu-quoted-"));
  const storePath = path.join(dir, "sessions.json");
  const sessionId = "sess-quoted-1";
  const sessionKey = "agent:main:feishu:dm:ou-attacker";
  const sessionFile = path.join(dir, `${sessionId}.jsonl`);

  fs.writeFileSync(
    storePath,
    JSON.stringify({
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        sessionFile,
      },
    }),
    "utf-8",
  );

  return { dir, storePath, sessionId, sessionKey, sessionFile };
}

function ensureSessionHeader(sessionFile: string, sessionId: string) {
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    })}\n`,
    "utf-8",
  );
}

function appendUserTurn(params: {
  sessionFile: string;
  messageId: string;
  body: string;
  contentType?: "text" | "input_text";
}) {
  const sessionManager = SessionManager.open(params.sessionFile);
  sessionManager.appendMessage({
    role: "user",
    content: [
      {
        type: params.contentType ?? "text",
        text: [
          "Conversation info (untrusted metadata):",
          "```json",
          JSON.stringify({ message_id: params.messageId }, null, 2),
          "```",
          "",
          params.body,
        ].join("\n"),
      },
    ],
    timestamp: Date.now(),
  });
  // SessionManager only flushes buffered turns after an assistant message exists.
  // Append a noop assistant turn so the quoted user message is actually persisted.
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "noop" }],
    api: "openai-responses",
    provider: "openclaw",
    model: "test-helper",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

function appendAssistantTurn(params: {
  sessionFile: string;
  body: string;
  contentType?: "text" | "output_text";
  messageMeta?: Record<string, unknown>;
}) {
  const sessionManager = SessionManager.open(params.sessionFile);
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: params.contentType ?? "text", text: params.body }],
    api: "openai-responses",
    provider: "openclaw",
    model: "test-helper",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...(params.messageMeta ? { openclawMessageMeta: params.messageMeta } : {}),
  });
}

function createBotCompanyDb(
  dbPath: string,
  rows: Array<{ chatId: string; messageId: string; content: string }>,
) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
CREATE TABLE chat_messages (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
`);
  const insert = db.prepare(
    `INSERT INTO chat_messages (chat_id, message_id, content) VALUES (?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(row.chatId, row.messageId, row.content);
  }
  db.close();
}

describe("resolveQuotedFeishuMessageContent", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    resetLiveSessionTranscriptRegistryForTests();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("prefers the session transcript for user reply targets in DMs", async () => {
    const fixture = createSessionFixture();
    cleanupDirs.push(fixture.dir);
    ensureSessionHeader(fixture.sessionFile, fixture.sessionId);
    appendUserTurn({
      sessionFile: fixture.sessionFile,
      messageId: "om_parent_ctx",
      body: "完整用户原文",
    });

    const fetchMessage = vi.fn(async () => null);
    const result = await resolveQuotedFeishuMessageContent({
      cfg: { session: { store: fixture.storePath } } as ClawdbotConfig,
      accountId: "default",
      agentId: "main",
      sessionKey: fixture.sessionKey,
      chatId: "oc_dm_1",
      parentId: "om_parent_ctx",
      isGroup: false,
      storePath: fixture.storePath,
      fetchMessage,
    });

    expect(result).toEqual({ content: "完整用户原文", source: "session" });
    expect(fetchMessage).not.toHaveBeenCalled();
  });

  it("reads DM quoted user content from input_text transcript blocks", async () => {
    const fixture = createSessionFixture();
    cleanupDirs.push(fixture.dir);
    ensureSessionHeader(fixture.sessionFile, fixture.sessionId);
    appendUserTurn({
      sessionFile: fixture.sessionFile,
      messageId: "om_parent_input_text",
      body: "input_text 里的完整原文",
      contentType: "input_text",
    });

    const fetchMessage = vi.fn(async () => null);
    const result = await resolveQuotedFeishuMessageContent({
      cfg: { session: { store: fixture.storePath } } as ClawdbotConfig,
      accountId: "default",
      agentId: "main",
      sessionKey: fixture.sessionKey,
      chatId: "oc_dm_1",
      parentId: "om_parent_input_text",
      isGroup: false,
      storePath: fixture.storePath,
      fetchMessage,
    });

    expect(result).toEqual({ content: "input_text 里的完整原文", source: "session" });
    expect(fetchMessage).not.toHaveBeenCalled();
  });

  it("prefers the live session transcript before the jsonl transcript in DMs", async () => {
    const fixture = createSessionFixture();
    cleanupDirs.push(fixture.dir);
    ensureSessionHeader(fixture.sessionFile, fixture.sessionId);

    const sessionManager = SessionManager.open(fixture.sessionFile);
    sessionManager.appendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "Conversation info (untrusted metadata):",
            "```json",
            JSON.stringify({ message_id: "om_parent_live" }, null, 2),
            "```",
            "",
            "来自 live session 的完整原文",
          ].join("\n"),
        },
      ],
      timestamp: Date.now(),
    });
    const unregister = registerLiveSessionTranscript({
      sessionKey: fixture.sessionKey,
      sessionId: fixture.sessionId,
      sessionReader: sessionManager,
    });

    try {
      const fetchMessage = vi.fn(async () => null);
      const result = await resolveQuotedFeishuMessageContent({
        cfg: { session: { store: fixture.storePath } } as ClawdbotConfig,
        accountId: "default",
        agentId: "main",
        sessionKey: fixture.sessionKey,
        chatId: "oc_dm_1",
        parentId: "om_parent_live",
        isGroup: false,
        storePath: fixture.storePath,
        fetchMessage,
      });

      expect(result).toEqual({ content: "来自 live session 的完整原文", source: "session" });
      expect(fetchMessage).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("matches mirrored assistant replies in the session transcript by provider message id", async () => {
    const fixture = createSessionFixture();
    cleanupDirs.push(fixture.dir);

    await appendAssistantMessageToSessionTranscript({
      storePath: fixture.storePath,
      sessionKey: fixture.sessionKey,
      text: "完整 bot 回复",
      messageMeta: {
        channel: "feishu",
        accountId: "default",
        chatId: "oc_dm_1",
        chatType: "direct",
        providerMessageId: "om_bot_2",
        providerMessageIds: ["om_bot_1", "om_bot_2"],
      },
    });

    const fetchMessage = vi.fn(async () => null);
    const result = await resolveQuotedFeishuMessageContent({
      cfg: { session: { store: fixture.storePath } } as ClawdbotConfig,
      accountId: "default",
      agentId: "main",
      sessionKey: fixture.sessionKey,
      chatId: "oc_dm_1",
      parentId: "om_bot_1",
      isGroup: false,
      storePath: fixture.storePath,
      fetchMessage,
    });

    expect(result).toEqual({ content: "完整 bot 回复", source: "session" });
    expect(fetchMessage).not.toHaveBeenCalled();
  });

  it("reads mirrored assistant replies from output_text transcript blocks", async () => {
    const fixture = createSessionFixture();
    cleanupDirs.push(fixture.dir);
    ensureSessionHeader(fixture.sessionFile, fixture.sessionId);
    appendAssistantTurn({
      sessionFile: fixture.sessionFile,
      body: "output_text 里的完整 bot 回复",
      contentType: "output_text",
      messageMeta: {
        channel: "feishu",
        accountId: "default",
        chatId: "oc_dm_1",
        chatType: "direct",
        providerMessageId: "om_bot_output_2",
        providerMessageIds: ["om_bot_output_1", "om_bot_output_2"],
      },
    });

    const fetchMessage = vi.fn(async () => null);
    const result = await resolveQuotedFeishuMessageContent({
      cfg: { session: { store: fixture.storePath } } as ClawdbotConfig,
      accountId: "default",
      agentId: "main",
      sessionKey: fixture.sessionKey,
      chatId: "oc_dm_1",
      parentId: "om_bot_output_1",
      isGroup: false,
      storePath: fixture.storePath,
      fetchMessage,
    });

    expect(result).toEqual({ content: "output_text 里的完整 bot 回复", source: "session" });
    expect(fetchMessage).not.toHaveBeenCalled();
  });

  it("falls back to the bot-company DB when the session transcript misses", async () => {
    const fixture = createSessionFixture();
    cleanupDirs.push(fixture.dir);
    ensureSessionHeader(fixture.sessionFile, fixture.sessionId);

    const dbPath = path.join(fixture.dir, "bot-company.db");
    createBotCompanyDb(dbPath, [
      { chatId: "oc_dm_1", messageId: "om_parent_db", content: "来自 DB 的完整内容" },
    ]);

    const fetchMessage = vi.fn(async () => null);
    const result = await resolveQuotedFeishuMessageContent({
      cfg: {
        session: { store: fixture.storePath },
        plugins: {
          entries: {
            "bot-company": {
              config: {
                dbPath,
              },
            },
          },
        },
      } as ClawdbotConfig,
      accountId: "default",
      agentId: "main",
      sessionKey: fixture.sessionKey,
      chatId: "oc_dm_1",
      parentId: "om_parent_db",
      isGroup: false,
      storePath: fixture.storePath,
      fetchMessage,
    });

    expect(result).toEqual({ content: "来自 DB 的完整内容", source: "db" });
    expect(fetchMessage).not.toHaveBeenCalled();
  });

  it("falls back to Feishu API when session transcript and DB both miss", async () => {
    const fixture = createSessionFixture();
    cleanupDirs.push(fixture.dir);
    ensureSessionHeader(fixture.sessionFile, fixture.sessionId);

    const fetchMessage = vi.fn(async () => ({
      messageId: "om_parent_api",
      chatId: "oc_dm_1",
      content: "来自 API 的降级内容",
      contentType: "text",
    }));

    const result = await resolveQuotedFeishuMessageContent({
      cfg: { session: { store: fixture.storePath } } as ClawdbotConfig,
      accountId: "default",
      agentId: "main",
      sessionKey: fixture.sessionKey,
      chatId: "oc_dm_1",
      parentId: "om_parent_api",
      isGroup: false,
      storePath: fixture.storePath,
      fetchMessage,
    });

    expect(result).toEqual({ content: "来自 API 的降级内容", source: "api" });
    expect(fetchMessage).toHaveBeenCalledTimes(1);
  });

  it("skips session and DB lookup for group replies", async () => {
    const fixture = createSessionFixture();
    cleanupDirs.push(fixture.dir);
    ensureSessionHeader(fixture.sessionFile, fixture.sessionId);
    appendUserTurn({
      sessionFile: fixture.sessionFile,
      messageId: "om_parent_group",
      body: "群聊 session 命中内容",
    });

    const dbPath = path.join(fixture.dir, "bot-company.db");
    createBotCompanyDb(dbPath, [
      { chatId: "oc_group_1", messageId: "om_parent_group", content: "群聊 DB 内容" },
    ]);

    const fetchMessage = vi.fn(async () => ({
      messageId: "om_parent_group",
      chatId: "oc_group_1",
      content: "群聊 API 内容",
      contentType: "text",
    }));

    const result = await resolveQuotedFeishuMessageContent({
      cfg: {
        session: { store: fixture.storePath },
        plugins: {
          entries: {
            "bot-company": {
              config: {
                dbPath,
              },
            },
          },
        },
      } as ClawdbotConfig,
      accountId: "default",
      agentId: "main",
      sessionKey: fixture.sessionKey,
      chatId: "oc_group_1",
      parentId: "om_parent_group",
      isGroup: true,
      storePath: fixture.storePath,
      fetchMessage,
    });

    expect(result).toEqual({ content: "群聊 API 内容", source: "api" });
    expect(fetchMessage).toHaveBeenCalledTimes(1);
  });
});
