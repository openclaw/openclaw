import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi, type TestPluginApiInput } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { ensureAuthProfileStore, resolveAuthProfileOrder } from "openclaw/plugin-sdk/provider-auth";
import { resolveProviderIdForAuth } from "openclaw/plugin-sdk/provider-auth-aliases";
import {
  closeOpenClawStateDatabaseAsync,
  drainSessionDiskBudgetWorkers,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import plugin from "../../index.js";
import { recordCodexAppServerAuthHandoff } from "./client-runtime.js";
import { CodexAppServerClient } from "./client.js";
import { isJsonObject } from "./protocol.js";
import {
  createParams,
  createStartedThreadHarness,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createCodexAppServerBindingStore,
  sessionBindingIdentity,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();
const ordinaryModel = "gpt-5.6-luna";
const recovered = {
  accountId: "account-a",
  rateLimitUpsell: null,
  ordinaryUsageAllowed: true,
  rateLimits: {},
};
const offered = {
  ...recovered,
  ordinaryUsageAllowed: false,
  rateLimitUpsell: {
    banner_type: "luna_reserve",
    title: "Reserve",
    description: "synthetic backend offer, not live eligibility",
    ctas: [],
    blocked_model_slug: ordinaryModel,
  },
};

// Compare Reserve use against the schema admitted by the normal core migration owner.
function inspectDatabase(database: string) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return {
      version: db.prepare("PRAGMA user_version").get(),
      schema: db
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
        .all(),
      integrity: db.prepare("PRAGMA integrity_check").get(),
      bindings: db
        .prepare("SELECT * FROM plugin_state_entries ORDER BY plugin_id, namespace, entry_key")
        .all(),
    };
  } finally {
    db.close();
  }
}

async function fixture() {
  const stateDir = path.join(tempDir, "upgraded-plugin-state");
  const database = path.join(stateDir, "state", "openclaw.sqlite");
  // Restore the complete old-producer SQL snapshot; never call a candidate schema or binding writer.
  const snapshot = await fs.readFile(
    new URL("./fixtures/reserve-upgrade-v2026.9.5/openclaw.sql", import.meta.url),
    "utf8",
  );
  expect(createHash("sha256").update(snapshot).digest("hex")).toBe(
    "5fb7bfb875593e244de9974d1234c4bc1c8c974ea02f6cde72d6fb591924175a",
  );
  await fs.mkdir(path.dirname(database), { recursive: true });
  const restored = new DatabaseSync(database);
  try {
    restored.exec(snapshot);
  } finally {
    restored.close();
  }
  const before = inspectDatabase(database);
  expect(before.version).toEqual({ user_version: 17 });
  expect(before.integrity).toEqual({ integrity_check: "ok" });
  // Main may legitimately advance its schema. Admit that upgrade through its owner,
  // not a Reserve migration, while preserving every byte of the historical binding row.
  openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } });
  const admitted = inspectDatabase(database);
  expect(admitted.bindings).toEqual(before.bindings);
  expect(admitted.integrity).toEqual(before.integrity);
  const bytes = await fs.readFile(database);
  const openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("codex", {
      ...options,
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
  const openStore = () =>
    createCodexAppServerBindingStore(
      openSyncKeyedStore<StoredCodexAppServerBinding>({
        namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      }),
    );
  let store = openStore();
  const params = createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace"));
  params.modelId = ordinaryModel;
  params.model = { ...params.model, id: ordinaryModel };
  params.fastMode = true;
  params.agentDir = path.join(tempDir, "agent");
  await attachSqliteSessionTarget(params, path.join(tempDir, "session.sqlite"), params.sessionId);
  const identity = sessionBindingIdentity(params);
  expect(store.read(identity)).toEqual({
    threadId: "thread-1",
    cwd: "/synthetic-upgrade-workspace",
    model: ordinaryModel,
    modelProvider: "openai",
    serviceTier: "priority",
    webSearchThreadConfigFingerprint: JSON.stringify({
      "features.standalone_web_search": false,
      web_search: "disabled",
    }),
    historyCoveredThrough: "2026-09-18T00:00:00.000Z",
  });
  // A Reserve reader must not rewrite the core-admitted file or normalize its old binding.
  expect(await fs.readFile(database)).toEqual(bytes);
  const native = {
    model: ordinaryModel,
    tier: "priority" as string | null,
    usage: recovered as unknown,
    starts: [] as unknown[],
    resumes: [] as unknown[],
    resumeError: false,
  };
  const wire = createStartedThreadHarness(
    async (method, raw) => {
      if (method === "thread/resume" || method === "thread/start") {
        if (method === "thread/resume") {
          native.resumes.push(raw);
        }
        if (method === "thread/resume" && native.resumeError) {
          throw new Error("synthetic missing upgraded native thread");
        }
        recordCodexAppServerAuthHandoff(wire.client, {
          accessFingerprint: "synthetic-upgrade-account",
          chatgptAccountId: "account-a",
        });
        const response = threadStartResult(method === "thread/start" ? "thread-new" : "thread-1");
        return {
          ...response,
          model: native.model,
          serviceTier: native.tier,
          thread: { ...response.thread, model: native.model },
        };
      }
      if (method === "account/rateLimits/read") {
        return native.usage;
      }
      if (method === "model/list") {
        return {
          data: [ordinaryModel, "gpt-reserve"].map((model) => ({
            id: model,
            model,
            displayName: model,
            description: "synthetic",
            hidden: model === "gpt-reserve",
            isDefault: false,
            inputModalities: ["text"],
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "medium" }],
            defaultReasoningEffort: "medium",
            serviceTiers: [],
            defaultServiceTier: null,
          })),
          nextCursor: null,
        };
      }
      if (method === "thread/settings/update") {
        throw new Error("Settings/input admission must be atomic");
      }
      if (method === "turn/start") {
        native.starts.push(raw);
        if (!isJsonObject(raw) || typeof raw.model !== "string") {
          throw new Error("Missing selected model");
        }
        native.model = raw.model;
        native.tier = typeof raw.serviceTier === "string" ? raw.serviceTier : null;
        return turnStartResult("upgrade-turn");
      }
      return undefined;
    },
    { persistedThreads: ["thread-1"] },
  );
  vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(wire.client);
  const pluginConfig = { sessionCatalog: { enabled: false } };
  const runtime = createPluginRuntimeMock({
    modelAuth: { ensureAuthProfileStore, resolveAuthProfileOrder, resolveProviderIdForAuth },
    config: { current: () => ({ plugins: { entries: { codex: { config: pluginConfig } } } }) },
    state: { openSyncKeyedStore },
  });
  const registerAgentHarness = vi.fn<NonNullable<TestPluginApiInput["registerAgentHarness"]>>();
  const register = () => {
    registerAgentHarness.mockClear();
    plugin.register(
      createTestPluginApi({
        id: "codex",
        rootDir: fileURLToPath(new URL("../../", import.meta.url)),
        pluginConfig,
        runtime,
        registerAgentHarness,
      }),
    );
    expect(registerAgentHarness).toHaveBeenCalledOnce();
    const registration = registerAgentHarness.mock.calls[0];
    if (!registration) {
      throw new Error("Missing registered Codex harness");
    }
    return registration[0];
  };
  let registered = register();
  const run = () => registered.runAttempt(params);
  const finish = async (
    operation: ReturnType<typeof run>,
    count: number,
    threadId = "thread-1",
  ) => {
    await Promise.race([
      vi.waitFor(() => expect(native.starts).toHaveLength(count), { interval: 1, timeout: 5_000 }),
      operation.then((result) => {
        throw new Error("Ended before turn/start", { cause: result });
      }),
    ]);
    await wire.completeTurn({ threadId, turnId: "upgrade-turn" });
    const result = await operation;
    expect(result).toHaveProperty("terminal", { kind: "ok" });
    return result;
  };
  return {
    params,
    native,
    wire,
    run,
    finish,
    read: () => store.read(sessionBindingIdentity(params)),
    readOriginal: () => store.read(identity),
    assertNoReserveMigration: () => {
      const after = inspectDatabase(database);
      expect(after.version).toEqual(admitted.version);
      expect(after.schema).toEqual(admitted.schema);
      expect(after.integrity).toEqual(admitted.integrity);
    },
    reopen: async () => {
      await drainSessionDiskBudgetWorkers();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      store = openStore();
      registered = register();
    },
    explicitNewSession: async () => {
      await registered.reset?.({
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        reason: "new",
      });
      await attachSqliteSessionTarget(
        params,
        path.join(tempDir, "session.sqlite"),
        "upgrade-new-session",
      );
    },
  };
}

describe("v2026.9.5 SQLite producer to registered candidate harness (synthetic backend)", () => {
  it("resumes marker-free ordinary state, then persists offered entry and recovery across reopen", async () => {
    const f = await fixture();
    await f.finish(f.run(), 1);
    expect(f.native.starts[0]).toMatchObject({
      threadId: "thread-1",
      model: ordinaryModel,
      serviceTier: "priority",
      effort: "medium",
    });
    expect(f.read()?.reserveReturn).toBeUndefined();
    expect(f.wire.requests.filter((r) => r.method === "thread/resume")).toHaveLength(1);
    expect(f.wire.requests.some((r) => r.method === "model/list")).toBe(false);
    f.native.usage = offered;
    const entered = await f.finish(f.run(), 2);
    expect(entered.runtimeModelSelection).toEqual({ provider: "openai", model: "gpt-reserve" });
    expect(f.native.starts[1]).toMatchObject({
      threadId: "thread-1",
      model: "gpt-reserve",
      serviceTier: null,
    });
    expect(f.read()?.reserveReturn).toEqual({
      accountId: "account-a",
      model: ordinaryModel,
      effort: "medium",
      serviceTier: "priority",
    });
    await f.reopen();
    expect(f.read()?.reserveReturn).toEqual({
      accountId: "account-a",
      model: ordinaryModel,
      effort: "medium",
      serviceTier: "priority",
    });
    await f.finish(f.run(), 3);
    // These are decoded wire requests, not pre-serialization builder objects.
    expect(f.native.resumes).toHaveLength(2);
    expect(f.native.resumes[1]).not.toHaveProperty("model");
    expect(f.native.resumes[1]).not.toHaveProperty("serviceTier");
    expect(f.native.starts[2]).toMatchObject({ model: "gpt-reserve", serviceTier: null });
    f.native.usage = recovered;
    const restored = await f.finish(f.run(), 4);
    expect(restored.runtimeModelSelection).toEqual({ provider: "openai", model: ordinaryModel });
    expect(f.native.starts[3]).toMatchObject({
      threadId: "thread-1",
      model: ordinaryModel,
      serviceTier: "priority",
      effort: "medium",
    });
    await f.reopen();
    expect(f.read()?.reserveReturn).toBeUndefined();
    expect(f.read()?.threadId).toBe("thread-1");
    expect(f.read()?.model).toBe(ordinaryModel);
    expect(f.wire.requests.filter((r) => r.method === "thread/start")).toEqual([]);
    f.assertNoReserveMigration();
  });

  it("does not treat persisted return intent as authority or silently replace its unavailable thread", async () => {
    const f = await fixture();
    f.native.usage = offered;
    await f.finish(f.run(), 1);
    await f.reopen();
    f.native.usage = { ...recovered, ordinaryUsageAllowed: undefined };
    await expect(f.run()).rejects.toThrow(
      "has not confirmed Reserve continuation or ordinary recovery",
    );
    expect(f.native.starts).toHaveLength(1);
    expect(f.read()?.reserveReturn).toBeDefined();
    f.native.resumeError = true;
    await expect(f.run()).rejects.toThrow("synthetic missing upgraded native thread");
    expect(f.wire.requests.filter((r) => r.method === "thread/start")).toEqual([]);
    expect(f.read()?.reserveReturn).toBeDefined();
    f.assertNoReserveMigration();
  });

  it("lets an explicit new session leave the old recovery intent without inheriting Reserve authority", async () => {
    const f = await fixture();
    f.native.usage = offered;
    await f.finish(f.run(), 1);
    await f.reopen();
    await f.explicitNewSession();
    f.native.model = ordinaryModel;
    f.native.tier = "priority";
    f.native.usage = recovered;
    await f.finish(f.run(), 2, "thread-new");
    expect(f.native.starts[1]).toMatchObject({
      threadId: "thread-new",
      model: ordinaryModel,
      serviceTier: "priority",
    });
    expect(f.read()).toMatchObject({ threadId: "thread-new", model: ordinaryModel });
    expect(f.read()?.reserveReturn).toBeUndefined();
    expect(f.readOriginal()).toBeUndefined();
    await f.reopen();
    expect(f.read()).toMatchObject({ threadId: "thread-new", model: ordinaryModel });
    expect(f.read()?.reserveReturn).toBeUndefined();
    expect(f.wire.requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
    f.assertNoReserveMigration();
  });
});
