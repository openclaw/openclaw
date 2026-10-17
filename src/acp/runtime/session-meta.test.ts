import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
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
import { createAcpMeta } from "./session-meta-lifecycle.test-support.js";
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
  return createAcpMeta({
    backend: "acpx",
    agent: "codex",
    runtimeSessionName,
    lastActivityAt: 123,
    ...overrides,
  });
}

function storeFixture(dir: string) {
  const storePath = path.join(dir, "sessions.json");
  const databasePath = path.join(dir, "state", "openclaw.sqlite");
  const cfg: OpenClawConfig = { session: { store: storePath } };
  const scope = { cfg, databasePath };
  return {
    storePath,
    databasePath,
    cfg,
    seed: (sessionKey: string, entry: SessionEntry) =>
      replaceSessionEntry({ agentId: ACP_AGENT_ID, storePath, sessionKey }, entry),
    stored: (sessionKey: string) =>
      loadSessionEntry({ agentId: ACP_AGENT_ID, storePath, sessionKey }),
    read: (sessionKey: string) => readAcpSessionEntry({ ...scope, sessionKey }),
    write: (
      sessionKey: string,
      options: Omit<Parameters<typeof upsertAcpSessionMeta>[0], "sessionKey">,
    ) => upsertAcpSessionMeta({ ...scope, sessionKey, ...options }),
    migrate: (
      sessionKey: string,
      options: Omit<Parameters<typeof writeAcpSessionMetaForMigration>[0], "sessionKey">,
    ) =>
      writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey: buildAcpDatabaseSessionKey(sessionKey, ACP_AGENT_ID),
        ...options,
      }),
  };
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
      const scope = { cfg, databasePath, sessionKey: "global" };
      const read = (agentId: string) =>
        readAcpSessionEntry({ ...scope, agentId })?.acp?.runtimeSessionName;
      for (const agentId of ["research", "ops"]) {
        await replaceSessionEntry(
          { agentId, storePath, sessionKey: "global" },
          { sessionId: `${agentId}-global`, updatedAt: 100 },
        );
        await upsertAcpSessionMeta({
          ...scope,
          agentId,
          mutate: () => createMeta(agentId),
        });
      }

      expect(read("research")).toBe("research");
      expect(read("ops")).toBe("ops");

      await upsertAcpSessionMeta({
        ...scope,
        agentId: "research",
        mutate: () => null,
      });
      expect(read("ops")).toBe("ops");
    });
  });

  it("creates a session-store row for new SQLite ACP sessions without embedding ACP metadata", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const { storePath, cfg, databasePath, stored, read, write } = storeFixture(dir);
      const sessionKey = "agent:codex:acp:new-session";

      const result = await write(sessionKey, {
        now: () => 200,
        mutate: () => createMeta("codex-new", { cwd: "/repo" }),
      });

      expect(result?.sessionId).toEqual(expect.any(String));
      expect(result?.acp).toEqual(createMeta("codex-new", { cwd: "/repo" }));
      expect(fs.existsSync(storePath)).toBe(false);
      const storedEntry = stored(sessionKey);
      expect(storedEntry).toMatchObject({
        sessionId: expect.any(String),
        lifecycleRevision: expect.any(String),
        updatedAt: expect.any(Number),
      });
      expect(storedEntry?.sessionStartedAt).toBeGreaterThan(200);
      expect(storedEntry?.acp).toBeUndefined();
      expect(read(sessionKey)?.acp).toMatchObject({
        runtimeSessionName: "codex-new",
        cwd: "/repo",
      });
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(1);
    });
  });

  it("binds ACP metadata to the final accessor-selected entry for alias writes", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const { cfg, databasePath, seed, stored, read, write } = storeFixture(dir);
      const canonicalSessionKey = "agent:codex:acp:alias-runtime";
      const legacyStoreSessionKey = "agent:CODEX:acp:alias-runtime";
      await seed(canonicalSessionKey, {
        sessionId: "sess-canonical",
        updatedAt: 100,
      });
      await seed(legacyStoreSessionKey, {
        sessionId: "sess-legacy",
        updatedAt: 150,
        acp: createMeta("legacy-embedded"),
      });

      await write(legacyStoreSessionKey, {
        now: () => 200,
        mutate: () => createMeta("codex-alias"),
      });

      const storedEntry = stored(canonicalSessionKey);
      expect(storedEntry?.sessionId).toBe("sess-legacy");
      expect(storedEntry?.acp).toBeUndefined();
      expect(read(canonicalSessionKey)?.acp?.runtimeSessionName).toBe("codex-alias");
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(1);
    });
  });

  it("ignores SQLite ACP metadata rows from an older lifecycle revision", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const { cfg, databasePath, seed, read, migrate } = storeFixture(dir);
      const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
      await seed(sessionKey, {
        sessionId: "sess-new",
        lifecycleRevision: "revision-new",
        updatedAt: 100,
      });

      migrate(sessionKey, {
        lifecycleRevision: "revision-old",
        meta: createMeta("codex-stale"),
      });

      expect(read(sessionKey)?.acp).toBeUndefined();
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(0);

      migrate(sessionKey, {
        lifecycleRevision: "revision-new",
        meta: createMeta("codex-current", { lastActivityAt: 124 }),
      });

      expect(read(sessionKey)?.acp?.runtimeSessionName).toBe("codex-current");
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

      const read = (entry: Parameters<typeof readAcpSessionMetaForEntry>[0]["entry"]) =>
        readAcpSessionMetaForEntry({ databasePath, sessionKey, agentId: ACP_AGENT_ID, entry });
      expect(
        read({ sessionId: "sess-pre-revision", sessionStartedAt: 50 })?.runtimeSessionName,
      ).toBe("codex-pre-revision");
      expect(
        read({
          sessionId: "sess-pre-revision",
          lifecycleRevision: "revision-after-reset",
          sessionStartedAt: 150,
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
          meta: createMeta("excluded-alias", { backend: "fixture", lastActivityAt: 100 }),
        });
        expect(readAcpSessionMetaForEntry({ databasePath, sessionKey, entry })).toBeUndefined();
      });
    },
  );
});

const SESSION_KEY = "agent:main:acp:alias-runtime";
const CANONICAL_META = createAcpMeta({
  backend: "fixture-backend",
  agent: "fixture-harness",
  runtimeSessionName: "canonical-runtime",
});

async function seedCanonicalSession(state: OpenClawTestState, sessionKey = SESSION_KEY) {
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: {} } },
  };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
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
        meta: createMeta("committed", { backend: "fixture", agent: "fixture", lastActivityAt: 1 }),
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
    const mutate = () => createMeta("global");
    const scope = { cfg, databasePath, sessionKey: "global" };
    const read = () => readAcpSessionEntry(scope)?.acp?.runtimeSessionName;

    const observed: Array<string | undefined> = [];
    const unsubscribe = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === "global" && change.agentId === "ops") {
        observed.push(read());
      }
    });
    try {
      const persisted = await upsertAcpSessionMeta({ ...scope, mutate });

      expect(persisted?.acp?.runtimeSessionName).toBe("global");
      expect(read()).toBe("global");
      const conflictingMutate = vi.fn(mutate);
      await expect(
        upsertAcpSessionMeta({
          ...scope,
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
      await upsertAcpSessionMeta({ ...scope, mutate: () => null });
      expect(observed.length).toBeGreaterThan(beforeDelete);
      expect(observed.at(-1)).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });
});
