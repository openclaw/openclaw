import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
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
import { resolveIMessageRecoveryCursorDbIdentity } from "./recovery-cursor.js";

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

  function startAccount(catchupEnabled = false) {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: {
          cliPath: path.join(stateDir, "synthetic-imsg"),
          dbPath,
          dmPolicy: "disabled",
          ...(catchupEnabled ? { catchup: { enabled: true } } : {}),
        },
      },
    };
    const account = resolveIMessageAccount({ cfg, accountId: "default" });
    const client = new IMessageRpcClient({ cliPath: account.config.cliPath, dbPath });
    const request = vi.spyOn(client, "request").mockImplementation(async (method) => {
      if (method === "watch.subscribe") {
        return { subscription: 1 };
      }
      if (method === "chats.list") {
        return { chats: [] };
      }
      throw new Error(`unexpected bridge method ${method}`);
    });
    vi.spyOn(client, "waitForClose").mockResolvedValue(undefined);
    createClient.mockResolvedValue(client);
    const starting = imessagePlugin.gateway!.startAccount!({
      scheduler: createTestPluginServiceScheduler(),
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

  it.each(["current", "legacy"] as const)(
    "rejects startup rather than skipping saved progress after a failed %s cursor read",
    async (kind) => {
      seedChatDb();
      const state = getIMessageRuntime().state;
      if (kind === "current") {
        state
          .openSyncKeyedStore<{ lastRowid: number }>({
            namespace: "imessage.recovery-cursor",
            maxEntries: 64,
          })
          .register(`default\u0000${resolveIMessageRecoveryCursorDbIdentity({ dbPath })}`, {
            lastRowid: 4990,
          });
      } else {
        state
          .openSyncKeyedStore<IMessageCatchupCursor>({
            namespace: IMESSAGE_CATCHUP_CURSOR_NAMESPACE,
            maxEntries: IMESSAGE_CATCHUP_CURSOR_MAX_ENTRIES,
          })
          .register(resolveIMessageCatchupCursorKey("default"), {
            lastSeenMs: Date.now(),
            lastSeenRowid: 4990,
            updatedAt: Date.now(),
          });
      }
      const failure = new Error("synthetic cursor read unavailable");
      let failReads = true;
      const open = state.openKeyedStoreV2.bind(state);
      vi.spyOn(state, "openKeyedStoreV2").mockImplementation(
        <T>(options: OpenAsyncKeyedStoreOptions) => {
          const store = open<T>(options);
          const method = kind === "current" ? "lookup" : "consume";
          const namespace =
            kind === "current" ? "imessage.recovery-cursor" : IMESSAGE_CATCHUP_CURSOR_NAMESPACE;
          if (options.namespace === namespace) {
            const read = store[method].bind(store);
            store[method] = async (key) => {
              if (failReads) {
                throw failure;
              }
              return await read(key);
            };
          }
          return store;
        },
      );
      const first = startAccount();
      await expect(first.starting).rejects.toBe(failure);
      expect(probe).not.toHaveBeenCalled();
      expect(first.request).not.toHaveBeenCalled();

      failReads = false;
      const recovered = startAccount();
      await recovered.starting;
      expect(recovered.request).toHaveBeenCalledWith(
        "watch.subscribe",
        expect.objectContaining({ since_rowid: 4990 }),
        expect.any(Object),
      );
    },
  );

  it("starts compatibility catchup when its unused recovery cursor is unavailable", async () => {
    seedChatDb();
    const state = getIMessageRuntime().state;
    const open = state.openKeyedStoreV2.bind(state);
    vi.spyOn(state, "openKeyedStoreV2").mockImplementation(
      <T>(options: OpenAsyncKeyedStoreOptions) => {
        if (options.namespace === "imessage.recovery-cursor") {
          throw new Error("synthetic unused recovery cursor unavailable");
        }
        return open<T>(options);
      },
    );

    const { request, starting } = startAccount(true);
    await starting;

    expect(request).toHaveBeenCalledWith(
      "watch.subscribe",
      { attachments: false, include_reactions: true },
      expect.any(Object),
    );
    expect(request).toHaveBeenCalledWith("chats.list", expect.any(Object), expect.any(Object));
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
            scheduler: createTestPluginServiceScheduler(),
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
