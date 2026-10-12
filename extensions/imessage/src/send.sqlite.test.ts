import { DatabaseSync, StatementSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMessageRpcClient } from "./client.js";
import { loadFreshIMessageReplyCacheForTest } from "./test-support/runtime.js";

describe("iMessage send SQLite receipt recovery", () => {
  let state: OpenClawTestState;
  let dbPath: string;
  let sendMessageIMessage: typeof import("./send.js").sendMessageIMessage;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-imessage-send-sqlite-",
    });
    await loadFreshIMessageReplyCacheForTest();
    ({ sendMessageIMessage } = await import("./send.js"));
    dbPath = state.path("synthetic-chat.db");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE message (
          ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date INTEGER,
          is_from_me INTEGER, handle_id INTEGER
        );
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, uncanonicalized_id TEXT);
        INSERT INTO chat VALUES (42, 'iMessage;-;+15550001111', '+15550001111');
        INSERT INTO chat VALUES (43, 'iMessage;-;+15550002222', '+15550002222');
        INSERT INTO handle VALUES (1, '+15550001111', '+1 (555) 000-1111');
        INSERT INTO handle VALUES (2, '+15550002222', '+1 (555) 000-2222');
        INSERT INTO message VALUES (5, 'older-guid', 'synthetic receipt', 0, 1, 1);
        INSERT INTO message VALUES (6, 'recovered-guid', 'synthetic receipt', 0, 1, 1);
        INSERT INTO message VALUES (7, 'other-chat-guid', 'synthetic receipt', 0, 1, 2);
        INSERT INTO message VALUES (8, 'incoming-guid', 'synthetic receipt', 0, 0, 1);
        INSERT INTO chat_message_join VALUES (42, 5), (42, 6), (43, 7), (42, 8);
      `);
    } finally {
      db.close();
    }
  });

  afterEach(async () => {
    const { clearIMessageApprovalReactionTargetsForTest } = await import("./approval-reactions.js");
    clearIMessageApprovalReactionTargetsForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
    await state.cleanup();
  });

  it("retains the reader across polling and joins cleanup before publishing the receipt", async () => {
    const sqliteRuntime = await import("openclaw/plugin-sdk/sqlite-runtime");
    const firstRead = createDeferred<void>();
    const firstResult = createDeferred<null>();
    const closing = createDeferred<void>();
    const closed = createDeferred<void>();
    const execute = vi
      .fn(async (): Promise<string | null> => "recovered-guid")
      .mockImplementationOnce(() => {
        firstRead.resolve();
        return firstResult.promise;
      });
    const close = vi.fn(() => {
      closing.resolve();
      return closed.promise;
    });
    const store = { execute, close } satisfies SqliteWorkerStore<SqliteWorkerOperations>;
    const open = vi.spyOn(sqliteRuntime, "openSqliteWorkerStore").mockResolvedValue(store);
    const client = new IMessageRpcClient({ dbPath });
    vi.spyOn(client, "request").mockRejectedValue(new Error("imsg rpc timeout (send)"));
    let settled = false;
    const sending = sendMessageIMessage("chat_id:42", "synthetic receipt", {
      config: { channels: { imessage: {} } },
      client,
      dbPath,
      approvalPrompt: {
        approvalId: "synthetic-approval",
        approvalKind: "exec",
        allowedDecisions: ["allow-once", "deny"],
      },
    }).then((result) => {
      settled = true;
      return result;
    });
    try {
      // Send persistence uses real workers; synchronize on reads without freezing their timers.
      await Promise.race([firstRead.promise, sending]);
      expect(execute).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      firstResult.resolve(null);
      await Promise.race([closing.promise, sending]);
      expect(close).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      closed.resolve();
      await expect(sending).resolves.toMatchObject({ guid: "recovered-guid" });
    } finally {
      firstResult.resolve(null);
      closed.resolve();
      await sending;
    }
  });

  it.each([
    { kind: "chat guid", target: "chat_guid:iMessage;-;+15550001111" },
    { kind: "chat identifier", target: "chat_identifier:+15550001111" },
    { kind: "handle", target: "+1 (555) 000-1111" },
  ])("recovers $kind through the default resolver off the caller thread", async ({ target }) => {
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    const get = vi.spyOn(StatementSync.prototype, "get");
    const prepareCalls = vi.spyOn(DatabaseSync.prototype, "prepare");
    const countMessageSelects = () =>
      prepareCalls.mock.calls.filter(([sql]) =>
        /\bSELECT\b[\s\S]*\bFROM\s+"?message"?\b/iu.test(sql),
      ).length;
    const calibration = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(calibration.prepare("SELECT guid FROM message WHERE ROWID = 6").get()).toMatchObject({
        guid: "recovered-guid",
      });
    } finally {
      calibration.close();
    }
    expect(countMessageSelects()).toBe(1);
    expect(get).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    vi.clearAllMocks();
    const client = new IMessageRpcClient({ dbPath });
    const request = vi.spyOn(client, "request");
    request.mockImplementation(async (_method, params) => {
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare("UPDATE message SET text = ?, date = ?").run(
          String(params?.text),
          (Date.now() - 978_307_200_000) * 1_000_000,
        );
      } finally {
        db.close();
      }
      throw new Error("imsg rpc timeout (send)");
    });
    const result = await sendMessageIMessage(target, "synthetic receipt", {
      config: { channels: { imessage: {} } },
      client,
      dbPath,
      approvalPrompt: {
        approvalId: "synthetic-approval",
        approvalKind: "exec",
        allowedDecisions: ["allow-once", "deny"],
      },
    });
    expect(result.guid).toBe("recovered-guid");
    expect(result.messageId).toBe("recovered-guid");
    expect(result.receipt.platformMessageIds).toEqual(["recovered-guid"]);
    expect(request).toHaveBeenCalledOnce();
    expect(countMessageSelects()).toBe(0);
  });
});
