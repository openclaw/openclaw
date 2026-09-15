// Voice Call tests cover doctor contract api plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionStoreAgentIds, stateMigrations } from "./doctor-contract-api.js";
import {
  createTestStorePath,
  installVoiceCallStateRuntimeForTests,
  makePersistedCall,
  writeLegacyCallsJsonl,
} from "./src/manager.test-harness.js";
import {
  CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
  CALL_RECORD_EVENTS_NAMESPACE,
  CALL_RECORD_CHUNK_MAX_ENTRIES,
  CALL_RECORD_EVENT_META_MAX_ENTRIES,
  buildVoiceCallLegacyJsonlEventKey,
  encodeCallRecordEvent,
  type CallRecordEventMeta,
  persistCallRecord,
  getCallHistoryFromStore,
  loadActiveCallsFromStore,
} from "./src/manager/store.js";
import { CallRecordSchema } from "./src/types.js";

function createDoctorContext(
  env: NodeJS.ProcessEnv,
  beforeWrite?: (namespace: string) => void,
): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      const store = createPluginStateKeyedStoreForTests<T>("voice-call", {
        ...options,
        env: options.env ?? env,
      });
      if (!beforeWrite) {
        return store;
      }
      const register = store.register.bind(store);
      return {
        ...store,
        async register(...args: Parameters<typeof store.register>) {
          beforeWrite(options.namespace);
          await register(...args);
        },
      };
    },
  };
}

describe.each(["default", "custom"] as const)("absent %s Voice Call store", (location) => {
  it.each(["detectLegacyState", "migrateLegacyState"] as const)(
    "%s leaves absent state untouched without loading repair machinery",
    async (method) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-call-absent-"));
      const store = path.join(root, location === "default" ? "voice-calls" : "custom-store");
      const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: root };
      vi.doMock("openclaw/plugin-sdk/doctor-repair-runtime", () => {
        throw new Error("absent Voice Call state must not load repair machinery");
      });
      try {
        const result = await expectDefined(stateMigrations[0], "voice-call state migration")[
          method
        ]({
          config:
            location === "custom"
              ? { plugins: { entries: { "voice-call": { config: { store } } } } }
              : {},
          env,
          stateDir: root,
          oauthDir: path.join(root, "oauth"),
          context: createDoctorContext(env),
        });
        expect(result).toEqual(
          method === "detectLegacyState" ? null : { changes: [], warnings: [] },
        );
        expect(await fs.readdir(root)).toEqual([]);
      } finally {
        vi.doUnmock("openclaw/plugin-sdk/doctor-repair-runtime");
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("voice-call doctor state migration", () => {
  let stateDir = "";
  let storePath = "";
  let env: NodeJS.ProcessEnv;
  let overCapacityMigration: {
    warnings: string[];
    changes: string[];
    activeCallIds: Set<string>;
    latestProviderCallId: string | undefined;
    historyCallIds: string[];
  };

  beforeAll(async () => {
    resetPluginStateStoreForTests();
    const warmStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-call-doctor-"));
    const warmStorePath = createTestStorePath();
    const warmEnv = {
      ...process.env,
      HOME: warmStateDir,
      OPENCLAW_STATE_DIR: warmStateDir,
    };
    try {
      installVoiceCallStateRuntimeForTests();
      const calls = Array.from({ length: 1002 }, (_, index) =>
        makePersistedCall({
          callId: `call-${index}`,
          providerCallId: `provider-${index}`,
        }),
      );
      writeLegacyCallsJsonl(warmStorePath, calls);
      const config = {
        plugins: {
          entries: {
            "@openclaw/voice-call": {
              config: { store: warmStorePath },
            },
          },
        },
      };
      const result = await expectDefined(
        stateMigrations[0],
        "voice-call state migration",
      ).migrateLegacyState({
        config,
        env: warmEnv,
        stateDir: warmStateDir,
        oauthDir: path.join(warmStateDir, "oauth"),
        context: createDoctorContext(warmEnv),
      });
      const restored = await loadActiveCallsFromStore(warmStorePath);
      const history = await getCallHistoryFromStore(warmStorePath, 1000);
      overCapacityMigration = {
        warnings: result.warnings,
        changes: result.changes,
        activeCallIds: new Set(restored.activeCalls.keys()),
        latestProviderCallId: restored.activeCalls.get("call-1001")?.providerCallId,
        historyCallIds: history.map((entry) => entry.callId),
      };
    } finally {
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      await fs.rm(warmStateDir, { recursive: true, force: true });
      await fs.rm(warmStorePath, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-call-doctor-"));
    storePath = createTestStorePath();
    env = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
    installVoiceCallStateRuntimeForTests();
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(storePath, { recursive: true, force: true });
  });

  it("reports top-level and per-number session-store agents", () => {
    expect(
      resolveSessionStoreAgentIds({
        cfg: {
          plugins: {
            entries: {
              "voice-call": {
                config: {
                  agentId: "Voice",
                  numbers: {
                    "+15550001111": { agentId: "Cards" },
                    "+15550002222": {},
                  },
                },
              },
            },
          },
        },
      }),
    ).toEqual(["cards", "voice"]);
    expect(
      resolveSessionStoreAgentIds({
        cfg: {
          plugins: { entries: { "@openclaw/voice-call": { config: {} } } },
        },
      }),
    ).toEqual(["main"]);
    expect(
      resolveSessionStoreAgentIds({
        cfg: {
          plugins: { entries: { "voice-call": { enabled: true } } },
        },
      }),
    ).toEqual(["main"]);
  });

  it("imports legacy calls.jsonl into plugin state", async () => {
    const sourcePath = path.join(storePath, "calls.jsonl");
    const call = makePersistedCall({
      callId: "call-doctor",
      providerCallId: "provider-doctor",
      processedEventIds: ["evt-doctor"],
    });
    writeLegacyCallsJsonl(storePath, [
      {
        version: 2,
        persistedAt: 1000,
        sequence: 0,
        call,
      },
    ]);

    const migration = expectDefined(stateMigrations[0], "voice-call state migration");
    const config = {
      plugins: {
        entries: {
          "@openclaw/voice-call": {
            config: { store: storePath },
          },
        },
      },
    };
    await expect(
      migration.detectLegacyState({
        config,
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      }),
    ).resolves.toMatchObject({
      preview: [expect.stringContaining("1 record")],
    });

    const result = await migration.migrateLegacyState({
      config,
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 1 Voice Call call-log record"),
      expect.stringContaining("Archived Voice Call call-log legacy source"),
    ]);
    await expect(fs.access(sourcePath)).rejects.toThrow();
    await fs.access(`${sourcePath}.migrated`);

    const restored = await loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.get("call-doctor")?.providerCallId).toBe("provider-doctor");
    expect(restored.processedEventIds.has("evt-doctor")).toBe(true);

    const history = await getCallHistoryFromStore(storePath);
    expect(history).toHaveLength(1);
    expect(history[0]?.callId).toBe("call-doctor");
  });

  it("honors OPENCLAW_STATE_DIR for the default store", async () => {
    const defaultStorePath = path.join(stateDir, "voice-calls");
    const call = makePersistedCall({
      callId: "call-isolated-state",
      providerCallId: "provider-isolated-state",
    });
    writeLegacyCallsJsonl(defaultStorePath, [call]);

    const migration = expectDefined(stateMigrations[0], "voice-call state migration");
    const params = {
      config: {
        plugins: {
          entries: {
            "voice-call": { config: {} },
          },
        },
      },
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };

    await expect(migration.detectLegacyState(params)).resolves.toMatchObject({
      preview: [expect.stringContaining("1 record")],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({
      changes: [
        expect.stringContaining("Migrated 1 Voice Call call-log record"),
        expect.stringContaining("Archived Voice Call call-log legacy source"),
      ],
      warnings: [],
    });

    expect(
      (await loadActiveCallsFromStore(defaultStorePath)).activeCalls.has("call-isolated-state"),
    ).toBe(true);
  });

  it("keeps literal $ patterns in home when resolving a tilde-configured store", async () => {
    const dollarHome = path.join(stateDir, "home$&d");
    const dollarStorePath = path.join(dollarHome, "dollar-store");
    const call = makePersistedCall({
      callId: "call-dollar-home",
      providerCallId: "provider-dollar-home",
    });
    await fs.mkdir(dollarStorePath, { recursive: true });
    writeLegacyCallsJsonl(dollarStorePath, [call]);
    const dollarEnv = { ...process.env, HOME: dollarHome, OPENCLAW_STATE_DIR: stateDir };

    const migration = expectDefined(stateMigrations[0], "voice-call state migration");
    const params = {
      config: {
        plugins: {
          entries: {
            "voice-call": { config: { store: "~/dollar-store" } },
          },
        },
      },
      env: dollarEnv,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(dollarEnv),
    };

    await expect(migration.detectLegacyState(params)).resolves.toMatchObject({
      preview: [expect.stringContaining("1 record")],
    });
  });

  it("repairs the plugin-local SQLite schema without a legacy call log", async () => {
    const databasePath = path.join(storePath, "state", "openclaw.sqlite");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`
        PRAGMA user_version = 1;
        CREATE TABLE audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          source_id TEXT NOT NULL UNIQUE,
          source_sequence INTEGER NOT NULL,
          occurred_at INTEGER NOT NULL,
          kind TEXT NOT NULL,
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          error_code TEXT,
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          session_key TEXT,
          session_id TEXT,
          run_id TEXT NOT NULL,
          tool_call_id TEXT,
          tool_name TEXT
        );
      `);
    } finally {
      db.close();
    }
    const migration = expectDefined(stateMigrations[0], "voice-call state migration");
    const config = {
      plugins: {
        entries: {
          "voice-call": {
            config: { store: storePath },
          },
        },
      },
    };
    const params = {
      config,
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [
        "- Voice Call SQLite schema: audit event ledger -> versioned message lifecycle schema",
        "- Voice Call SQLite schema: tables -> SQLite STRICT typing",
      ],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [
        "Migrated Voice Call SQLite audit event ledger -> versioned message lifecycle schema",
        expect.stringMatching(
          /^Migrated Voice Call SQLite tables to SQLite STRICT typing \(\d+\)$/,
        ),
      ],
      warnings: [],
    });
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    expect((await loadActiveCallsFromStore(storePath)).activeCalls.size).toBe(0);
  });

  it("imports the newest legacy call records when the JSONL log is over capacity", () => {
    expect(overCapacityMigration.warnings).toEqual([
      expect.stringContaining("Pruned 2 older Voice Call call-log records"),
    ]);
    expect(overCapacityMigration.changes).toEqual([
      expect.stringContaining("Migrated 1000 Voice Call call-log records"),
      expect.stringContaining("Archived Voice Call call-log legacy source"),
    ]);
    expect(overCapacityMigration.activeCallIds.has("call-0")).toBe(false);
    expect(overCapacityMigration.activeCallIds.has("call-1")).toBe(false);
    expect(overCapacityMigration.latestProviderCallId).toBe("provider-1001");
    expect(overCapacityMigration.historyCallIds).toHaveLength(1000);
    expect(overCapacityMigration.historyCallIds[0]).toBe("call-2");
    expect(overCapacityMigration.historyCallIds.at(-1)).toBe("call-1001");
  });

  it.each([1, 2])(
    "retains the source and written prefix after chunk write %s fails",
    async (failedWrite) => {
      const call = makePersistedCall({
        callId: "call-write-failure",
        transcript: [{ timestamp: 1, speaker: "user", text: "x".repeat(100_000), isFinal: true }],
      });
      writeLegacyCallsJsonl(storePath, [call]);
      const failure = new Error("chunk write failed");
      let writes = 0;
      const beforeWrite = vi.fn((_namespace: string) => {
        if (++writes === failedWrite) {
          throw failure;
        }
      });
      const params = {
        config: { plugins: { entries: { "voice-call": { config: { store: storePath } } } } },
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env, beforeWrite),
      };
      const migration = expectDefined(stateMigrations[0], "voice-call state migration");
      const result = await migration.migrateLegacyState(params);
      expect(result).toEqual({
        changes: [],
        warnings: [
          "Failed migrating Voice Call call-log line 1: Error: chunk write failed",
          "Left Voice Call call-log source in place because migration was incomplete",
        ],
      });
      expect(beforeWrite.mock.calls).toEqual(
        Array.from({ length: failedWrite }, () => [CALL_RECORD_EVENT_CHUNKS_NAMESPACE]),
      );
      await fs.access(path.join(storePath, "calls.jsonl"));
      await expect(fs.access(path.join(storePath, "calls.jsonl.migrated"))).rejects.toThrow();
      const { db } = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: storePath } });
      expect(
        db
          .prepare(
            "SELECT namespace, json_extract(value_json, '$.index') AS chunk_index FROM plugin_state_entries WHERE plugin_id = ? ORDER BY entry_key",
          )
          .all("voice-call"),
      ).toEqual(
        Array.from({ length: failedWrite - 1 }, (_, index) => ({
          namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
          chunk_index: index,
        })),
      );
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([]);
      const retried = await migration.migrateLegacyState({
        ...params,
        context: createDoctorContext(env),
      });
      expect(retried.warnings).toEqual([]);
      await fs.access(path.join(storePath, "calls.jsonl.migrated"));
      await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([call]);
    },
  );

  it("leaves malformed mixed legacy logs in place after importing valid records", async () => {
    const sourcePath = path.join(storePath, "calls.jsonl");
    const call = makePersistedCall({
      callId: "call-valid",
      providerCallId: "provider-valid",
    });
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, `${JSON.stringify(call)}\n{not json}\n`);

    const config = {
      plugins: {
        entries: {
          "@openclaw/voice-call": {
            config: { store: storePath },
          },
        },
      },
    };
    const result = await expectDefined(
      stateMigrations[0],
      "voice-call state migration",
    ).migrateLegacyState({
      config,
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 1 Voice Call call-log record"),
    ]);
    expect(result.warnings).toEqual([
      "Skipped malformed Voice Call call-log line 2",
      "Left Voice Call call-log source in place because migration was incomplete",
    ]);
    await fs.access(sourcePath);
    await expect(fs.access(`${sourcePath}.migrated`)).rejects.toThrow();
    expect((await loadActiveCallsFromStore(storePath)).activeCalls.has("call-valid")).toBe(true);
  });
  it.each(["runtime-first", "doctor-first"] as const)(
    "uses compatible non-evicting namespaces across %s opens",
    async (order) => {
      const runtimeCall = CallRecordSchema.parse(makePersistedCall({ callId: "runtime-policy" }));
      const legacyCall = makePersistedCall({ callId: "doctor-policy" });
      writeLegacyCallsJsonl(storePath, [legacyCall]);
      if (order === "runtime-first") {
        await persistCallRecord(storePath, runtimeCall);
      }
      const result = await expectDefined(
        stateMigrations[0],
        "voice-call state migration",
      ).migrateLegacyState({
        config: { plugins: { entries: { "voice-call": { config: { store: storePath } } } } },
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      });
      expect(result.warnings).toEqual([]);
      if (order === "doctor-first") {
        await persistCallRecord(storePath, runtimeCall);
      }
      const history = await getCallHistoryFromStore(storePath);
      expect(history).toEqual(expect.arrayContaining([runtimeCall, legacyCall]));
      expect(history).toHaveLength(2);
    },
  );

  it("replays a complete prefix after failed metadata publication at full chunk capacity", async () => {
    const call = makePersistedCall({
      callId: "doctor-metadata-retry",
      transcript: [{ timestamp: 1, speaker: "user", text: "x".repeat(100_000), isFinal: true }],
    });
    writeLegacyCallsJsonl(storePath, [call]);
    const source = await fs.readFile(path.join(storePath, "calls.jsonl"));
    const params = {
      config: { plugins: { entries: { "voice-call": { config: { store: storePath } } } } },
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env, (namespace) => {
        if (namespace === CALL_RECORD_EVENTS_NAMESPACE) {
          throw new Error("metadata publication refused");
        }
      }),
    };
    const migration = expectDefined(stateMigrations[0], "voice-call state migration");
    const failed = await migration.migrateLegacyState(params);
    expect(failed.warnings).toEqual([
      "Failed migrating Voice Call call-log line 1: Error: metadata publication refused",
      "Left Voice Call call-log source in place because migration was incomplete",
    ]);
    expect(await fs.readFile(path.join(storePath, "calls.jsonl"))).toEqual(source);
    const { db } = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: storePath } });
    const prefix = db
      .prepare(
        "SELECT entry_key, value_json FROM plugin_state_entries WHERE namespace = ? ORDER BY entry_key",
      )
      .all(CALL_RECORD_EVENT_CHUNKS_NAMESPACE);
    expect(prefix.length).toBeGreaterThan(1);
    // Leave no room for new chunk keys; overwriting the owned prefix is sufficient.
    db.prepare(`
      WITH RECURSIVE slots(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM slots WHERE n < ?
      )
      INSERT INTO plugin_state_entries
        (plugin_id, namespace, entry_key, value_json, created_at, expires_at)
      SELECT 'voice-call', ?, 'pressure:' || n, '{}', 0, NULL FROM slots
    `).run(CALL_RECORD_CHUNK_MAX_ENTRIES - prefix.length, CALL_RECORD_EVENT_CHUNKS_NAMESPACE);
    await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([]);
    // Runtime startup must leave Doctor's retained prefix to its replay owner.
    await loadActiveCallsFromStore(storePath);
    expect(
      db
        .prepare(
          "SELECT entry_key, value_json FROM plugin_state_entries WHERE namespace = ? AND entry_key LIKE 'jsonl:%' ORDER BY entry_key",
        )
        .all(CALL_RECORD_EVENT_CHUNKS_NAMESPACE),
    ).toEqual(prefix);
    const retried = await migration.migrateLegacyState({
      ...params,
      context: createDoctorContext(env),
    });
    expect(retried.warnings).toEqual([]);
    expect(await fs.readFile(path.join(storePath, "calls.jsonl.migrated"))).toEqual(source);
    await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([call]);
    expect(
      (
        await migration.migrateLegacyState({
          ...params,
          context: createDoctorContext(env),
        })
      ).warnings,
    ).toEqual([]);
    await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([call]);
  });

  it("retains source and previous history when chunk capacity prevents a new import", async () => {
    const previous = CallRecordSchema.parse(makePersistedCall({ callId: "capacity-previous" }));
    await persistCallRecord(storePath, previous);
    const incoming = makePersistedCall({ callId: "capacity-unimported" });
    writeLegacyCallsJsonl(storePath, [incoming]);
    const source = await fs.readFile(path.join(storePath, "calls.jsonl"));
    const { db } = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: storePath } });
    db.prepare(`
      WITH RECURSIVE slots(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM slots WHERE n < ?
      )
      INSERT INTO plugin_state_entries
        (plugin_id, namespace, entry_key, value_json, created_at, expires_at)
      SELECT 'voice-call', ?, 'pressure:' || n, '{}', 0, NULL FROM slots
    `).run(CALL_RECORD_CHUNK_MAX_ENTRIES - 1, CALL_RECORD_EVENT_CHUNKS_NAMESPACE);
    const retained = db
      .prepare("SELECT * FROM plugin_state_entries ORDER BY namespace, entry_key")
      .all();
    const result = await expectDefined(
      stateMigrations[0],
      "voice-call state migration",
    ).migrateLegacyState({
      config: { plugins: { entries: { "voice-call": { config: { store: storePath } } } } },
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "Skipped Voice Call call-log migration for 1 record because chunk capacity is unavailable",
      "Left Voice Call call-log source in place because migration was incomplete",
    ]);
    expect(await fs.readFile(path.join(storePath, "calls.jsonl"))).toEqual(source);
    await expect(fs.access(path.join(storePath, "calls.jsonl.migrated"))).rejects.toThrow();
    expect(
      db.prepare("SELECT * FROM plugin_state_entries ORDER BY namespace, entry_key").all(),
    ).toEqual(retained);
    await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([previous]);
  });

  // Seed complete snapshots through the runtime writer and incomplete owners
  // through the same real keyed store, without running destructive recovery.
  async function seedRetentionFixture(completeCount: number, incompleteCount = 0) {
    const calls = Array.from({ length: completeCount }, (_, index) =>
      CallRecordSchema.parse(makePersistedCall({ callId: `retained-${index}` })),
    );
    for (const call of calls) {
      await persistCallRecord(storePath, call);
    }
    const events = createPluginStateKeyedStoreForTests<CallRecordEventMeta>("voice-call", {
      namespace: CALL_RECORD_EVENTS_NAMESPACE,
      maxEntries: CALL_RECORD_EVENT_META_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      env: { ...env, OPENCLAW_STATE_DIR: storePath },
    });
    const incompleteMeta = encodeCallRecordEvent(
      CallRecordSchema.parse(makePersistedCall({ callId: "interrupted-runtime" })),
    ).meta;
    for (let index = 0; index < incompleteCount; index++) {
      await events.register(
        `event:interrupted:${String(index).padStart(6, "0")}:fixture`,
        incompleteMeta,
      );
    }
    const { db } = openOpenClawStateDatabase({ env: { ...env, OPENCLAW_STATE_DIR: storePath } });
    return {
      calls,
      events,
      incompleteMeta,
      rows: () =>
        db
          .prepare(
            "SELECT * FROM plugin_state_entries WHERE plugin_id = 'voice-call' ORDER BY namespace, entry_key",
          )
          .all(),
    };
  }

  function retentionMigrationParams(context = createDoctorContext(env)) {
    return {
      config: { plugins: { entries: { "voice-call": { config: { store: storePath } } } } },
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };
  }

  it("imports the 1000th complete record beside interrupted runtime metadata without reclaiming it", async () => {
    const { calls, events, incompleteMeta, rows } = await seedRetentionFixture(999, 1);
    const incoming = CallRecordSchema.parse(makePersistedCall({ callId: "eligible-jsonl" }));
    writeLegacyCallsJsonl(storePath, [incoming]);
    const sourcePath = path.join(storePath, "calls.jsonl");
    const source = await fs.readFile(sourcePath);
    const retained = rows();
    const result = await expectDefined(
      stateMigrations[0],
      "voice-call state migration",
    ).migrateLegacyState(retentionMigrationParams());
    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 1 Voice Call call-log record"),
      expect.stringContaining("Archived Voice Call call-log legacy source"),
    ]);
    expect(await fs.readFile(`${sourcePath}.migrated`)).toEqual(source);
    await expect(fs.access(sourcePath)).rejects.toThrow();
    expect(await events.lookup("event:interrupted:000000:fixture")).toEqual(incompleteMeta);
    expect(await events.count?.()).toBe(1001);
    expect(rows()).toEqual(expect.arrayContaining(retained));
    const history = await getCallHistoryFromStore(storePath, 1001);
    expect(history).toHaveLength(1000);
    expect(history).toEqual(expect.arrayContaining([...calls, incoming]));
    // No source left to replay, and the incomplete owner is still untouched.
    const afterImport = rows();
    expect(
      await expectDefined(stateMigrations[0], "voice-call state migration").migrateLegacyState(
        retentionMigrationParams(),
      ),
    ).toEqual({ changes: [], warnings: [] });
    expect(rows()).toEqual(afterImport);
  });

  it("keeps deliberate retention pruning when 1000 complete records already exist", async () => {
    const { calls, rows } = await seedRetentionFixture(1000);
    const incoming = makePersistedCall({ callId: "over-complete-quota" });
    writeLegacyCallsJsonl(storePath, [incoming]);
    const sourcePath = path.join(storePath, "calls.jsonl");
    const source = await fs.readFile(sourcePath);
    const retained = rows();
    const result = await expectDefined(
      stateMigrations[0],
      "voice-call state migration",
    ).migrateLegacyState(retentionMigrationParams());
    expect(result.warnings).toEqual([
      expect.stringContaining("Pruned 1 older Voice Call call-log record"),
    ]);
    expect(result.changes).toEqual([
      expect.stringContaining("Archived Voice Call call-log legacy source"),
    ]);
    expect(await fs.readFile(`${sourcePath}.migrated`)).toEqual(source);
    await expect(fs.access(sourcePath)).rejects.toThrow();
    expect(rows()).toEqual(retained);
    await expect(getCallHistoryFromStore(storePath, 1001)).resolves.toEqual(calls);
  });

  it("retains eligible source when incomplete owners occupy all physical metadata slots", async () => {
    const { calls, rows } = await seedRetentionFixture(
      999,
      CALL_RECORD_EVENT_META_MAX_ENTRIES - 999,
    );
    writeLegacyCallsJsonl(storePath, [makePersistedCall({ callId: "physical-room-refused" })]);
    const sourcePath = path.join(storePath, "calls.jsonl");
    const source = await fs.readFile(sourcePath);
    const retained = rows();
    const result = await expectDefined(
      stateMigrations[0],
      "voice-call state migration",
    ).migrateLegacyState(retentionMigrationParams());
    expect(result).toEqual({
      warningDisposition: "recoverable",
      changes: [],
      warnings: [
        "Skipped Voice Call call-log migration for 1 record because metadata capacity is unavailable",
        "Left Voice Call call-log source in place because migration was incomplete",
      ],
    });
    expect(await fs.readFile(sourcePath)).toEqual(source);
    await expect(fs.access(`${sourcePath}.migrated`)).rejects.toThrow();
    expect(rows()).toEqual(retained);
    await expect(getCallHistoryFromStore(storePath, 1001)).resolves.toEqual(calls);
    // The updater can now finish without deleting live rows from Doctor. A real
    // runtime start reclaims interruption debris, and a later repair imports it.
    await loadActiveCallsFromStore(storePath);
    const completed = await expectDefined(
      stateMigrations[0],
      "voice-call state migration",
    ).migrateLegacyState(retentionMigrationParams());
    expect(completed.warnings).toEqual([]);
    expect(await fs.readFile(`${sourcePath}.migrated`)).toEqual(source);
    await expect(fs.access(sourcePath)).rejects.toThrow();
    expect(await getCallHistoryFromStore(storePath, 1001)).toHaveLength(1000);
  });

  it.each(["unknown", "malformed", "unreadable"] as const)(
    "keeps metadata capacity blocking when %s owners cannot be recovered by runtime",
    async (kind) => {
      const { events, rows } = await seedRetentionFixture(0);
      const chunks = createDoctorContext(env).openPluginStateKeyedStore({
        namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
        maxEntries: CALL_RECORD_CHUNK_MAX_ENTRIES,
        overflowPolicy: "reject-new",
        env: { ...env, OPENCLAW_STATE_DIR: storePath },
      });
      const invalidPayload = Buffer.from("not-json");
      for (let index = 0; index < CALL_RECORD_EVENT_META_MAX_ENTRIES; index++) {
        const key = `${kind === "unknown" ? "unknown" : "event"}:blocked:${index}:fixture`;
        await events.register(key, {
          chunkCount: kind === "malformed" ? 0 : 1,
          byteLength: kind === "malformed" ? 0 : invalidPayload.length,
        });
        if (kind === "unreadable") {
          await chunks.register(`${key}:chunk:0000`, {
            index: 0,
            dataBase64: invalidPayload.toString("base64"),
          });
        }
      }
      writeLegacyCallsJsonl(storePath, [makePersistedCall({ callId: "not-recoverable" })]);
      const sourcePath = path.join(storePath, "calls.jsonl");
      const source = await fs.readFile(sourcePath);
      const retained = rows();
      const result = await expectDefined(
        stateMigrations[0],
        "voice-call state migration",
      ).migrateLegacyState(retentionMigrationParams());
      expect(result.warningDisposition).toBeUndefined();
      expect(result.warnings).toContain(
        "Skipped Voice Call call-log migration for 1 record because metadata capacity is unavailable",
      );
      expect(rows()).toEqual(retained);
      expect(await fs.readFile(sourcePath)).toEqual(source);
      await expect(fs.access(`${sourcePath}.migrated`)).rejects.toThrow();
    },
  );

  it("does not treat an unreadable existing deterministic owner as an imported source record", async () => {
    const { events, rows } = await seedRetentionFixture(0);
    const call = CallRecordSchema.parse(makePersistedCall({ callId: "incomplete-jsonl-owner" }));
    writeLegacyCallsJsonl(storePath, [call]);
    const sourcePath = path.join(storePath, "calls.jsonl");
    const source = await fs.readFile(sourcePath);
    const line = expectDefined(source.toString("utf8").split("\n")[0], "legacy line");
    await events.register(
      buildVoiceCallLegacyJsonlEventKey(line, 0),
      encodeCallRecordEvent(call).meta,
    );
    const retained = rows();
    const result = await expectDefined(
      stateMigrations[0],
      "voice-call state migration",
    ).migrateLegacyState(retentionMigrationParams());
    expect(result).toEqual({
      changes: [],
      warnings: [
        "Skipped Voice Call call-log migration for line 1 because existing metadata is incomplete",
        "Left Voice Call call-log source in place because migration was incomplete",
      ],
    });
    expect(rows()).toEqual(retained);
    expect(await fs.readFile(sourcePath)).toEqual(source);
    await expect(fs.access(`${sourcePath}.migrated`)).rejects.toThrow();
  });

  it("preserves a completion-read error and live source before admitting any import", async () => {
    const { rows } = await seedRetentionFixture(1);
    writeLegacyCallsJsonl(storePath, [makePersistedCall({ callId: "unadmitted-jsonl" })]);
    const sourcePath = path.join(storePath, "calls.jsonl");
    const source = await fs.readFile(sourcePath);
    const retained = rows();
    const failure = new Error("completion lookup failed");
    const context: PluginDoctorStateMigrationContext = {
      openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
        const store = createPluginStateKeyedStoreForTests<T>("voice-call", {
          ...options,
          env: options.env ?? env,
        });
        if (options.namespace !== CALL_RECORD_EVENT_CHUNKS_NAMESPACE) {
          return store;
        }
        return {
          ...store,
          async lookup(_key: string): Promise<T | undefined> {
            throw failure;
          },
        };
      },
    };
    await expect(
      expectDefined(stateMigrations[0], "voice-call state migration").migrateLegacyState(
        retentionMigrationParams(context),
      ),
    ).rejects.toBe(failure);
    expect(rows()).toEqual(retained);
    expect(await fs.readFile(sourcePath)).toEqual(source);
    await expect(fs.access(`${sourcePath}.migrated`)).rejects.toThrow();
  });
});
