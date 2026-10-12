// Voice Call tests cover doctor contract api plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionStoreAgentIds, stateMigrations } from "./doctor-contract-api.js";
import {
  installVoiceCallStateRuntimeForTests,
  makePersistedCall,
} from "./src/manager.test-harness.js";
import { loadActiveCallsFromStore } from "./src/manager/store.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  });
});

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("voice-call", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

describe.each(["default", "custom"] as const)("absent %s Voice Call store", (location) => {
  it.each(["detectLegacyState", "migrateLegacyState"] as const)(
    "%s leaves absent state untouched without loading repair machinery",
    async (method) => {
      const root = tempDirs.make("openclaw-voice-call-absent-");
      const store = path.join(root, location === "default" ? "voice-calls" : "custom-store");
      const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: root };
      vi.doMock("openclaw/plugin-sdk/doctor-repair-runtime", () => {
        throw new Error("absent Voice Call state must not load repair machinery");
      });
      try {
        const result = await expectDefined(stateMigrations[1], "voice-call schema migration")[
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
      }
    },
  );
});

describe("voice-call doctor state migration", () => {
  let stateDir = "";
  let storePath = "";
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = tempDirs.make("openclaw-voice-call-doctor-");
    storePath = path.join(stateDir, "custom-store");
    env = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
    installVoiceCallStateRuntimeForTests();
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

  it.each(["default", "custom", "tilde"] as const)(
    "refuses the retired %s call log without changing its bytes or creating SQLite state",
    async (location) => {
      const home = path.join(stateDir, "home$&d");
      const store =
        location === "default"
          ? path.join(stateDir, "voice-calls")
          : location === "tilde"
            ? path.join(home, "dollar-store")
            : storePath;
      await fs.mkdir(store, { recursive: true });
      const source = path.join(store, "calls.jsonl");
      const bytes = Buffer.from(
        `${JSON.stringify(makePersistedCall({ callId: "unmigrated" }))}\n{invalid retained bytes\n`,
      );
      await fs.writeFile(source, bytes);
      const migration = expectDefined(stateMigrations[0], "retired call-log migration");
      const params = {
        config: {
          plugins: {
            entries: {
              "voice-call": {
                config:
                  location === "default"
                    ? {}
                    : { store: location === "tilde" ? "~/dollar-store" : store },
              },
            },
          },
        },
        env: { ...env, HOME: home },
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      };
      await expect(migration.detectLegacyState(params)).resolves.toMatchObject({
        preview: [expect.stringContaining(source)],
      });
      await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({
        changes: [],
        warnings: [expect.stringContaining("2026.9.7")],
      });
      expect(await fs.readFile(source)).toEqual(bytes);
      expect(await fs.readdir(store)).toEqual(["calls.jsonl"]);
    },
  );

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
    const migration = expectDefined(stateMigrations[1], "voice-call schema migration");
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
});
