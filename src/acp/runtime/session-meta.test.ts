/** Tests ACP session metadata persistence, joins, and migration helpers. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadExactSessionEntry,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../../state/openclaw-state-ownership-operations.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { buildAcpDatabaseSessionKey, selectAcpSessionRow } from "./session-meta-keys.js";
import { readAcpSessionMetaForEntry } from "./session-meta-readonly.js";
import {
  listAcpSessionEntries,
  readAcpSessionEntry,
  upsertAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "./session-meta.js";
import { withAcpSessionTestDir as withTestDir } from "./session-meta.test-support.js";

const ACP_AGENT_ID = "codex";

function createMeta(
  runtimeSessionName: string,
  overrides: Partial<SessionAcpMeta> = {},
): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName,
    mode: "persistent",
    state: "idle",
    lastActivityAt: 123,
    ...overrides,
  };
}

async function seedAcpSessionEntry(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
}): Promise<void> {
  await replaceSessionEntry(
    {
      agentId: ACP_AGENT_ID,
      storePath: params.storePath,
      sessionKey: params.sessionKey,
    },
    params.entry,
  );
}

function readStoredAcpSessionEntry(params: {
  storePath: string;
  sessionKey: string;
}): SessionEntry | undefined {
  return loadSessionEntry({
    agentId: ACP_AGENT_ID,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
  });
}

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

describe("ACP session metadata SQLite store", () => {
  it("reads metadata under external state ownership without write admission", async () => {
    await withTestDir({ prefix: "openclaw-acp-read-only-owner-" }, async (dir) => {
      const env = { OPENCLAW_STATE_DIR: dir };
      const externalEnv = { ...env, OPENCLAW_SUPERVISOR_MODE: "external" };
      const cfg = {
        agents: { ownership: "explicit", entries: { main: {} } },
      } satisfies OpenClawConfig;
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const storePath = path.join(dir, "agents", "main", "agent", "openclaw-agent.sqlite");
      const sessionKey = "agent:main:proof";
      await replaceSessionEntry(
        { agentId: "main", storePath, sessionKey, env },
        { sessionId: "proof-session", updatedAt: 100 },
      );
      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        env,
        sessionKey,
        mutate: () => createMeta("proof-runtime", { lastActivityAt: 100 }),
      });
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      claimOpenClawStateOwnership("test-supervisor", { env: externalEnv });
      await closeOpenClawStateDatabaseAsync();
      const before = fs.readFileSync(databasePath);

      expect(readAcpSessionEntry({ cfg, databasePath, env, sessionKey })?.acp).toMatchObject({
        runtimeSessionName: "proof-runtime",
      });
      expect(fs.readFileSync(databasePath)).toEqual(before);
    });
  });

  it("keeps identical bare keys isolated by explicit agent owner", async () => {
    await withTestDir({ prefix: "openclaw-acp-pair-owner-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = {
        session: { store: storePath },
        agents: { ownership: "explicit", entries: { research: {}, ops: {} } },
      } satisfies OpenClawConfig;
      for (const agentId of ["research", "ops"]) {
        await replaceSessionEntry(
          { agentId, storePath, sessionKey: "global" },
          { sessionId: `${agentId}-global`, updatedAt: 100 },
        );
        await upsertAcpSessionMeta({
          cfg,
          databasePath,
          sessionKey: "global",
          agentId,
          mutate: () => createMeta(agentId),
        });
      }

      expect(
        readAcpSessionEntry({ cfg, databasePath, sessionKey: "global", agentId: "research" })?.acp
          ?.runtimeSessionName,
      ).toBe("research");
      expect(
        readAcpSessionEntry({ cfg, databasePath, sessionKey: "global", agentId: "ops" })?.acp
          ?.runtimeSessionName,
      ).toBe("ops");

      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey: "global",
        agentId: "research",
        mutate: () => null,
      });
      expect(
        readAcpSessionEntry({ cfg, databasePath, sessionKey: "global", agentId: "ops" })?.acp
          ?.runtimeSessionName,
      ).toBe("ops");
    });
  });

  it("creates a session-store row for new SQLite ACP sessions without embedding ACP metadata", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:new-session";

      const result = await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        now: () => 200,
        mutate: () => createMeta("codex-new", { cwd: "/repo" }),
      });

      expect(result?.sessionId).toEqual(expect.any(String));
      expect(result?.acp).toEqual(createMeta("codex-new", { cwd: "/repo" }));
      expect(fs.existsSync(storePath)).toBe(false);
      const storedEntry = readStoredAcpSessionEntry({ storePath, sessionKey });
      expect(storedEntry?.sessionId).toEqual(expect.any(String));
      expect(storedEntry?.lifecycleRevision).toEqual(expect.any(String));
      expect(storedEntry?.updatedAt).toEqual(expect.any(Number));
      expect(storedEntry?.sessionStartedAt).toBeGreaterThan(200);
      expect(storedEntry?.acp).toBeUndefined();
      expect(readAcpSessionEntry({ cfg, databasePath, sessionKey })?.acp).toMatchObject({
        runtimeSessionName: "codex-new",
        cwd: "/repo",
      });
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(1);
    });
  });

  it("binds ACP metadata to the final accessor-selected entry for alias writes", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const canonicalSessionKey = "agent:codex:acp:alias-runtime";
      const legacyStoreSessionKey = "agent:CODEX:acp:alias-runtime";
      await seedAcpSessionEntry({
        storePath,
        sessionKey: canonicalSessionKey,
        entry: {
          sessionId: "sess-canonical",
          updatedAt: 100,
        },
      });
      await seedAcpSessionEntry({
        storePath,
        sessionKey: legacyStoreSessionKey,
        entry: {
          sessionId: "sess-legacy",
          updatedAt: 150,
          acp: createMeta("legacy-embedded"),
        },
      });

      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey: legacyStoreSessionKey,
        now: () => 200,
        mutate: () => createMeta("codex-alias"),
      });

      const storedEntry = readStoredAcpSessionEntry({ storePath, sessionKey: canonicalSessionKey });
      expect(storedEntry?.sessionId).toBe("sess-legacy");
      expect(storedEntry?.acp).toBeUndefined();
      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey: canonicalSessionKey,
        })?.acp?.runtimeSessionName,
      ).toBe("codex-alias");
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(1);
    });
  });

  it("ignores SQLite ACP metadata rows from an older lifecycle revision", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
      await seedAcpSessionEntry({
        storePath,
        sessionKey,
        entry: {
          sessionId: "sess-new",
          lifecycleRevision: "revision-new",
          updatedAt: 100,
        },
      });

      writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey: buildAcpDatabaseSessionKey(sessionKey, ACP_AGENT_ID),
        lifecycleRevision: "revision-old",
        meta: createMeta("codex-stale"),
      });

      expect(readAcpSessionEntry({ cfg, databasePath, sessionKey })?.acp).toBeUndefined();
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(0);

      writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey: buildAcpDatabaseSessionKey(sessionKey, ACP_AGENT_ID),
        lifecycleRevision: "revision-new",
        meta: createMeta("codex-current", { lastActivityAt: 124 }),
      });

      expect(readAcpSessionEntry({ cfg, databasePath, sessionKey })?.acp?.runtimeSessionName).toBe(
        "codex-current",
      );
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(1);
    });
  });

  it("keeps a session-id fence when ACP metadata is written before a lifecycle revision", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const sessionKey = "agent:codex:acp:pre-revision";
      writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey: buildAcpDatabaseSessionKey(sessionKey, ACP_AGENT_ID),
        sessionId: "sess-pre-revision",
        now: () => 100,
        meta: createMeta("codex-pre-revision", { lastActivityAt: 100 }),
      });

      expect(
        readAcpSessionMetaForEntry({
          databasePath,
          sessionKey,
          agentId: ACP_AGENT_ID,
          entry: {
            sessionId: "sess-pre-revision",
            lifecycleRevision: undefined,
            sessionStartedAt: 50,
          },
        })?.runtimeSessionName,
      ).toBe("codex-pre-revision");
      expect(
        readAcpSessionMetaForEntry({
          databasePath,
          sessionKey,
          agentId: ACP_AGENT_ID,
          entry: {
            sessionId: "sess-pre-revision",
            lifecycleRevision: "revision-after-reset",
            sessionStartedAt: 150,
          },
        }),
      ).toBeUndefined();
    });
  });

  it.each(["agent:codex:ordinary", "acp:bare"])(
    "does not case-fold metadata outside free ACP keys: %s",
    async (sessionKey) => {
      await withTestDir({ prefix: "openclaw-acp-case-boundary-" }, async (dir) => {
        const databasePath = path.join(dir, "state", "openclaw.sqlite");
        const entry = {
          sessionId: "case-boundary",
          lifecycleRevision: "case-revision",
          updatedAt: 100,
        };
        writeAcpSessionMetaForMigration({
          databasePath,
          sessionKey: sessionKey.toUpperCase(),
          lifecycleRevision: entry.lifecycleRevision,
          meta: {
            backend: "fixture",
            agent: "codex",
            runtimeSessionName: "excluded-alias",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 100,
          },
        });
        expect(readAcpSessionMetaForEntry({ databasePath, sessionKey, entry })).toBeUndefined();
      });
    },
  );
});

const SESSION_KEY = "agent:main:acp:alias-runtime";
const CANONICAL_META: SessionAcpMeta = {
  backend: "fixture-backend",
  agent: "fixture-harness",
  runtimeSessionName: "canonical-runtime",
  mode: "persistent",
  state: "idle",
  lastActivityAt: 100,
};

async function seedCanonicalSession(state: OpenClawTestState, sessionKey = SESSION_KEY) {
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: {} } },
  };
  await state.writeConfig(cfg);
  const scope = { cfg, env: state.env, agentId: "main", sessionKey };
  await replaceSessionEntry(scope, {
    sessionId: "alias-session",
    lifecycleRevision: "alias-revision",
    sessionStartedAt: 50,
    updatedAt: 100,
  });
  const entry = loadExactSessionEntry(scope)?.entry;
  if (!entry) {
    throw new Error("Expected the canonical session fixture");
  }
  const canonicalKey = buildAcpDatabaseSessionKey(sessionKey, "main");
  writeAcpSessionMetaForMigration({
    env: state.env,
    sessionKey: canonicalKey,
    lifecycleRevision: entry.lifecycleRevision,
    meta: CANONICAL_META,
    now: () => 100,
  });
  const snapshot = () => {
    const { db } = openOpenClawStateDatabase({ env: state.env });
    return {
      rows: db.prepare("SELECT * FROM acp_sessions ORDER BY session_key").all(),
      sources: db.prepare("SELECT * FROM migration_sources ORDER BY source_key").all(),
      runs: db.prepare("SELECT * FROM migration_runs ORDER BY id").all(),
    };
  };
  return { scope, entry, canonicalKey, snapshot };
}

async function seedAliases(state: OpenClawTestState) {
  const fixture = await seedCanonicalSession(state);
  const aliases = [
    { key: SESSION_KEY.toUpperCase(), binding: "alias-revision", updatedAt: 100 },
    { key: "agent:MAIN:acp:alias-runtime", binding: "alias-session", updatedAt: 100 },
    { key: "Agent:main:acp:alias-runtime", binding: undefined, updatedAt: 100 },
  ];
  const retained = [
    { key: "agent:main:ACP:alias-runtime", binding: "old-revision", updatedAt: 100 },
    { key: "agent:main:acp:ALIAS-runtime", binding: "alias-session", updatedAt: 49 },
    { key: "agent:other:acp:alias-runtime", binding: "alias-revision", updatedAt: 100 },
  ];
  for (const row of [...aliases, ...retained]) {
    writeAcpSessionMetaForMigration({
      env: state.env,
      sessionKey: row.key,
      lifecycleRevision: row.binding,
      meta: { ...CANONICAL_META, runtimeSessionName: row.key, lastActivityAt: 200 },
      now: () => row.updatedAt,
    });
  }
  return fixture;
}

describe("ACP raw alias lifecycle", () => {
  it("updates and closes canonical metadata while preserving historical aliases", async () => {
    await withOpenClawTestState({ label: "acp-alias-update" }, async (state) => {
      const fixture = await seedAliases(state);
      const before = fixture.snapshot();
      const retainedRows = before.rows.filter((row) => row.session_key !== fixture.canonicalKey);
      const updated = { ...CANONICAL_META, runtimeSessionName: "updated-runtime" };
      await upsertAcpSessionMeta({
        ...fixture.scope,
        mutate: (current) => {
          expect(current).toEqual(CANONICAL_META);
          return updated;
        },
      });
      const after = fixture.snapshot();
      expect(after.rows.filter((row) => row.session_key !== fixture.canonicalKey)).toEqual(
        retainedRows,
      );
      expect(after.sources).toEqual(before.sources);
      expect(after.runs).toEqual(before.runs);
      expect(readAcpSessionEntry(fixture.scope)?.acp).toEqual(updated);
      await upsertAcpSessionMeta({ ...fixture.scope, mutate: () => null });
      expect(fixture.snapshot().rows).toEqual(retainedRows);
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      expect(readAcpSessionEntry(fixture.scope)?.acp).toBeUndefined();
    });
  });

  it.each(["keep", "revoked-update"] as const)(
    "%s preserves rows, receipts, entry, and events without replaying the callback",
    async (operation) => {
      await withOpenClawTestState({ label: `acp-alias-${operation}` }, async (state) => {
        const fixture = await seedAliases(state);
        const before = fixture.snapshot();
        const entryBefore = loadExactSessionEntry(fixture.scope);
        const changes: unknown[] = [];
        const unsubscribe = sessionChanges.subscribe((change) => changes.push(change));
        let current = true;
        const mutate = vi.fn((value: SessionAcpMeta | undefined) => {
          expect(value).toEqual(CANONICAL_META);
          current = operation === "keep";
          return operation === "keep"
            ? undefined
            : { ...CANONICAL_META, runtimeSessionName: "unauthorized-runtime" };
        });
        try {
          const pending = upsertAcpSessionMeta({
            ...fixture.scope,
            mutate,
            assertCommitAllowed: () => {
              if (!current) {
                throw new Error("ACP mutation owner revoked");
              }
            },
          });
          if (operation === "keep") {
            expect((await pending)?.acp).toEqual(CANONICAL_META);
          } else {
            await expect(pending).rejects.toThrow("ACP mutation owner revoked");
          }
          expect(mutate).toHaveBeenCalledOnce();
          expect(fixture.snapshot()).toEqual(before);
          expect(loadExactSessionEntry(fixture.scope)).toEqual(entryBefore);
          expect(readAcpSessionEntry(fixture.scope)?.acp).toEqual(CANONICAL_META);
          expect(changes).toEqual([]);
        } finally {
          unsubscribe();
        }
      });
    },
  );
});

it.each([
  {
    databaseKey: buildAcpDatabaseSessionKey("global", "ops"),
    targets: [{ agentId: "ops", sessionKey: "global" }],
  },
  { databaseKey: "@agent:ops:global", targets: [] },
  { databaseKey: "agent:main:acp:project", targets: [] },
  { databaseKey: "agent:MAIN:acp:PROJECT", targets: [] },
])("publishes only canonical ACP identities after commit for $databaseKey", async (fixture) => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const { db } = openOpenClawStateDatabase({ env });
    const observed: Array<{ change: SessionRowChange; transaction: boolean; row: unknown }> = [];
    const unsubscribe = sessionChanges.subscribe((change) => {
      observed.push({
        change,
        transaction: db.isTransaction,
        row: selectAcpSessionRow(db, fixture.databaseKey)?.runtime_session_name,
      });
    });
    const write = () =>
      writeAcpSessionMetaForMigration({
        env,
        sessionKey: fixture.databaseKey,
        meta: {
          backend: "fixture",
          agent: "fixture",
          runtimeSessionName: "committed",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 1,
        },
      });
    try {
      expect(() =>
        runOpenClawStateWriteTransaction(
          () => {
            write();
            expect(observed).toEqual([]);
            throw new Error("rollback");
          },
          { env },
        ),
      ).toThrow("rollback");
      expect(observed).toEqual([]);
      write();
      expect(observed).toEqual(
        fixture.targets.map((change) => ({
          change,
          transaction: false,
          row: "committed",
        })),
      );
    } finally {
      unsubscribe();
    }
  });
});

it("persists bare global metadata under a configured fixed-store owner", async () => {
  await withTestDir({ prefix: "openclaw-acp-global-owner-" }, async (dir) => {
    const storePath = path.join(dir, "sessions.json");
    const cfg = {
      session: { scope: "global", store: storePath },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;
    const databasePath = path.join(dir, "state", "openclaw.sqlite");
    await replaceSessionEntry(
      {
        agentId: "ops",
        storePath,
        sessionKey: "global",
      },
      { sessionId: "ops-global", updatedAt: 100, sessionStartedAt: 100 },
    );
    const mutate = () => ({
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "global",
      mode: "persistent" as const,
      state: "idle" as const,
      lastActivityAt: 123,
    });

    const observed: Array<string | undefined> = [];
    const unsubscribe = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === "global" && change.agentId === "ops") {
        observed.push(
          readAcpSessionEntry({ cfg, databasePath, sessionKey: "global" })?.acp?.runtimeSessionName,
        );
      }
    });
    try {
      const persisted = await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey: "global",
        mutate,
      });

      expect(persisted?.acp?.runtimeSessionName).toBe("global");
      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey: "global",
        })?.acp?.runtimeSessionName,
      ).toBe("global");
      const conflictingMutate = vi.fn(mutate);
      await expect(
        upsertAcpSessionMeta({
          cfg,
          databasePath,
          sessionKey: "global",
          agentId: "research",
          mutate: conflictingMutate,
        }),
      ).rejects.toMatchObject({ code: "AGENT_SELECTION_REQUIRED" });
      expect(conflictingMutate).not.toHaveBeenCalled();
      const ownerlessCfg = {
        ...cfg,
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      } satisfies OpenClawConfig;
      const ownerlessMutate = vi.fn(mutate);
      await expect(
        upsertAcpSessionMeta({
          cfg: ownerlessCfg,
          databasePath,
          sessionKey: "ownerless-global",
          mutate: ownerlessMutate,
        }),
      ).rejects.toMatchObject({ code: "AGENT_SELECTION_REQUIRED" });
      expect(ownerlessMutate).not.toHaveBeenCalled();
      expect(observed.at(-1)).toBe("global");
      const beforeDelete = observed.length;
      await upsertAcpSessionMeta({ cfg, databasePath, sessionKey: "global", mutate: () => null });
      expect(observed.length).toBeGreaterThan(beforeDelete);
      expect(observed.at(-1)).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });
});
