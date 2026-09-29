import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIMessageAccount } from "../accounts.js";
import { imessagePlugin } from "../channel.js";
import { IMessageRpcClient, type createIMessageRpcClient } from "../client.js";
import { getIMessageRuntime } from "../runtime.js";
import {
  IMESSAGE_CATCHUP_CURSOR_MAX_ENTRIES,
  IMESSAGE_CATCHUP_CURSOR_NAMESPACE,
  resolveIMessageCatchupCursorKey,
  type IMessageCatchupCursor,
} from "../state-contract.js";
import { installIMessageStateRuntimeForTest } from "../test-support/runtime.js";

const { createClient, probe } = vi.hoisted(() => ({
  createClient: vi.fn<typeof createIMessageRpcClient>(),
  probe: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client.js")>()),
  createIMessageRpcClient: createClient,
}));

vi.mock("../probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../probe.js")>()),
  probeIMessage: probe,
}));

describe("registered iMessage account startup", () => {
  let stateDir: string;
  let dbPath: string;

  beforeEach(() => {
    installIMessageStateRuntimeForTest();
    stateDir = getIMessageRuntime().state.resolveStateDir();
    dbPath = path.join(stateDir, "synthetic-chat.db");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    createClient.mockReset();
    probe.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function seedChatDb() {
    const database = new DatabaseSync(dbPath);
    try {
      database.exec(
        "CREATE TABLE message (text TEXT); INSERT INTO message(rowid, text) VALUES (5000, 'watermark');",
      );
    } finally {
      database.close();
    }
  }

  function startAccount() {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: { cliPath: path.join(stateDir, "synthetic-imsg"), dbPath, dmPolicy: "disabled" },
      },
    };
    const account = resolveIMessageAccount({ cfg, accountId: "default" });
    const client = new IMessageRpcClient({ cliPath: account.config.cliPath, dbPath });
    const request = vi.spyOn(client, "request").mockImplementation(async (method) => {
      if (method === "watch.subscribe") {
        return { subscription: 1 };
      }
      throw new Error(`unexpected bridge method ${method}`);
    });
    vi.spyOn(client, "waitForClose").mockResolvedValue(undefined);
    createClient.mockResolvedValue(client);
    const starting = imessagePlugin.gateway!.startAccount!({
      cfg,
      accountId: account.accountId,
      account,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: new AbortController().signal,
      getStatus: () => ({ accountId: account.accountId }),
      setStatus: vi.fn(),
    });
    return { request, starting };
  }

  it("reads the startup watermark off the caller thread before subscribing", async () => {
    seedChatDb();
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const watermarkQueries = () =>
      prepare.mock.calls.filter(([sql]) =>
        /\bMAX\s*\([\s\S]*\bROWID\b[\s\S]*\bFROM\s+"?message"?\b/iu.test(sql),
      );
    const calibration = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(calibration.prepare("SELECT MAX(ROWID) AS maxRowid FROM message").get()).toMatchObject(
        { maxRowid: 5000 },
      );
    } finally {
      calibration.close();
    }
    expect(watermarkQueries()).toHaveLength(1);
    prepare.mockClear();

    const { request, starting } = startAccount();
    await starting;

    expect(request).toHaveBeenCalledWith(
      "watch.subscribe",
      expect.objectContaining({ since_rowid: 5000 }),
      expect.any(Object),
    );
    expect(watermarkQueries()).toHaveLength(0);
  });

  it("joins startup watermark cleanup before probing or subscribing", async () => {
    seedChatDb();
    const closing = createDeferred<void>();
    const releaseClose = createDeferred<void>();
    const open = sqliteRuntime.openSqliteWorkerStore;
    vi.spyOn(sqliteRuntime, "openSqliteWorkerStore").mockImplementation(async (options) => {
      const store = await open(options);
      if (store && options.databasePath === dbPath) {
        const close = store.close.bind(store);
        store.close = async () => {
          closing.resolve();
          await releaseClose.promise;
          await close();
        };
      }
      return store;
    });
    const { request, starting } = startAccount();
    try {
      await Promise.race([closing.promise, starting]);
      expect(probe).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      releaseClose.resolve();
      await starting;
    }
    expect(request).toHaveBeenCalledWith(
      "watch.subscribe",
      expect.objectContaining({ since_rowid: 5000 }),
      expect.any(Object),
    );
  });

  it.each(["missing", "invalid"])(
    "keeps startup diagnostics and watch fallback when the Messages database is %s",
    async (kind) => {
      if (kind === "invalid") {
        fs.writeFileSync(dbPath, "synthetic invalid SQLite database");
      }
      const diagnostic = vi.spyOn(runtimeEnv, "logVerbose");
      const { request, starting } = startAccount();
      await starting;

      expect(request).toHaveBeenCalledWith(
        "watch.subscribe",
        { attachments: false, include_reactions: true },
        expect.any(Object),
      );
      expect(diagnostic).toHaveBeenCalledWith(
        expect.stringContaining(`imessage: startup rowid watermark unavailable for db=${dbPath}:`),
      );
      expect(fs.existsSync(dbPath)).toBe(kind === "invalid");
    },
  );

  it.each([
    { name: "recovers the oldest rows from a 100-message chat", total: 100, twoChats: false },
    { name: "caps each pass when a 500-message chat dominates", total: 600, twoChats: true },
  ])(
    "imessagePlugin.gateway.startAccount $name across persisted starts",
    async ({ total, twoChats }) => {
      const backlogStartMs = Date.now() - 20 * 60_000;
      const rows = Array.from({ length: total }, (_, index) => ({
        id: index + 1,
        guid: `catchup-startup-${index + 1}`,
        chat_id: twoChats && index < 100 ? 2 : 1,
        chat_identifier: "+15555550123",
        chat_guid: "iMessage;-;+15555550123",
        sender: "+15555550123",
        is_from_me: false,
        is_group: false,
        text: "missed during downtime",
        created_at: new Date(backlogStartMs + (index + 1) * 1_000).toISOString(),
      }));
      const cfg: OpenClawConfig = {
        channels: {
          imessage: {
            cliPath: path.join(stateDir, "synthetic-imsg"),
            // Admission is the boundary under test; ordinary policy completes the rows
            // without starting unrelated agent turns.
            dmPolicy: "disabled",
            catchup: { enabled: true, perRunLimit: 50, maxAgeMinutes: 60 },
          },
        },
      };
      const account = resolveIMessageAccount({ cfg, accountId: "default" });
      const cursorStore = getIMessageRuntime().state.openSyncKeyedStore<IMessageCatchupCursor>({
        namespace: IMESSAGE_CATCHUP_CURSOR_NAMESPACE,
        maxEntries: IMESSAGE_CATCHUP_CURSOR_MAX_ENTRIES,
      });
      const cursorKey = resolveIMessageCatchupCursorKey(account.accountId);
      cursorStore.register(cursorKey, {
        lastSeenMs: backlogStartMs,
        lastSeenRowid: 0,
        updatedAt: Date.now(),
      });
      const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
        readOnly: true,
      });
      try {
        for (let end = 50; end <= total; end += 50) {
          const client = new IMessageRpcClient({ cliPath: cfg.channels?.imessage?.cliPath });
          const request = vi.spyOn(client, "request").mockImplementation(async (method, params) => {
            if (method === "watch.subscribe") {
              return { subscription: 1 };
            }
            if (method === "chats.list") {
              return {
                chats: (twoChats ? [1, 2] : [1]).map((id) => ({
                  id,
                  last_message_at: rows.at(-1)!.created_at,
                })),
              };
            }
            if (method === "messages.history") {
              const { chat_id, limit, start } = params!;
              if (typeof limit !== "number" || typeof start !== "string") {
                throw new Error("history request must carry its limit and lower date bound");
              }
              // Match the external bridge: filter by date, then select newest first.
              return {
                messages: rows
                  .filter(
                    (row) =>
                      row.chat_id === chat_id && Date.parse(row.created_at) >= Date.parse(start),
                  )
                  .toSorted(
                    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id,
                  )
                  .slice(0, limit),
              };
            }
            throw new Error(`unexpected bridge method ${method}`);
          });
          // The monitor calls this after catchup finishes, then drains real ingress
          // during shutdown before the next registered account start.
          vi.spyOn(client, "waitForClose").mockResolvedValue(undefined);
          createClient.mockResolvedValue(client);
          const runtime = {
            log: vi.fn(),
            error: vi.fn(),
            exit: vi.fn((code: number) => {
              throw new Error(`unexpected exit ${code}`);
            }),
          };
          await imessagePlugin.gateway!.startAccount!({
            cfg,
            accountId: account.accountId,
            account,
            runtime,
            abortSignal: new AbortController().signal,
            getStatus: () => ({ accountId: account.accountId }),
            setStatus: vi.fn(),
          });

          const admitted = database
            .prepare(
              "SELECT event_id, status FROM channel_ingress_events WHERE channel_id = 'imessage' AND account_id = 'default' ORDER BY rowid",
            )
            .all();
          expect(admitted.map((row) => row.event_id)).toEqual(
            Array.from({ length: end }, (_, index) => `catchup-startup-${index + 1}`),
          );
          expect(admitted.every((row) => row.status === "completed")).toBe(true);
          expect(cursorStore.lookup(cursorKey)).toMatchObject({
            lastSeenRowid: end,
            lastSeenMs: backlogStartMs + end * 1_000,
          });
          const historyCalls = request.mock.calls.filter(
            ([method]) => method === "messages.history",
          );
          expect(historyCalls).toHaveLength(twoChats ? 2 : 1);
          for (const [, params] of historyCalls) {
            expect(params).toMatchObject({ limit: 500 });
          }
          expect(runtime.error).not.toHaveBeenCalled();
        }
      } finally {
        database.close();
      }
    },
  );
});
