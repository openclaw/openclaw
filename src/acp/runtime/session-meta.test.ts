/** Tests ACP session metadata persistence, joins, and migration helpers. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../../state/openclaw-state-ownership-operations.js";
import { buildAcpDatabaseSessionKey } from "./session-meta-keys.js";
import { readAcpSessionMetaForEntry } from "./session-meta-readonly.js";
import {
  listAcpSessionEntries,
  readAcpSessionEntry,
  readAcpSessionMetaBatch,
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

describe("ACP session metadata SQLite store", () => {
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
  });

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

  it("persists ACP metadata in SQLite without writing sessions.json acp blocks", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
      await seedAcpSessionEntry({
        storePath,
        sessionKey,
        entry: {
          sessionId: "sess-acp",
          updatedAt: 100,
        },
      });

      const result = await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        now: () => 200,
        mutate: () => createMeta("codex-discord", { cwd: "/repo" }),
      });

      expect(result?.acp?.runtimeSessionName).toBe("codex-discord");
      expect(fs.existsSync(storePath)).toBe(false);
      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey,
        })?.acp,
      ).toMatchObject({
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "codex-discord",
        mode: "persistent",
        state: "idle",
        cwd: "/repo",
      });
    });
  });

  it("clears legacy embedded ACP metadata through the session accessor", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
      await seedAcpSessionEntry({
        storePath,
        sessionKey,
        entry: {
          sessionId: "sess-acp",
          updatedAt: 100,
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "legacy-embedded",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 120,
          },
        },
      });

      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey,
        now: () => 200,
        mutate: () => createMeta("codex-sqlite"),
      });

      expect(readStoredAcpSessionEntry({ storePath, sessionKey })?.acp).toBeUndefined();
      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey,
        })?.acp?.runtimeSessionName,
      ).toBe("codex-sqlite");
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
        mutate: () => createMeta("codex-new"),
      });

      expect(result?.sessionId).toEqual(expect.any(String));
      expect(result?.acp?.runtimeSessionName).toBe("codex-new");
      const storedEntry = readStoredAcpSessionEntry({ storePath, sessionKey });
      expect(storedEntry?.sessionId).toEqual(expect.any(String));
      expect(storedEntry?.lifecycleRevision).toEqual(expect.any(String));
      expect(storedEntry?.updatedAt).toEqual(expect.any(Number));
      expect(storedEntry?.sessionStartedAt).toBeGreaterThan(200);
      expect(storedEntry?.acp).toBeUndefined();
      expect(readAcpSessionEntry({ cfg, databasePath, sessionKey })?.acp?.runtimeSessionName).toBe(
        "codex-new",
      );
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(1);
    });
  });

  it("normalizes ACP metadata lookups and writes to the resolved session-store key", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const storeSessionKey = "agent:codex:acp:binding:discord:default:feedface";
      const rawSessionKey = storeSessionKey.toUpperCase();
      await seedAcpSessionEntry({
        storePath,
        sessionKey: storeSessionKey,
        entry: {
          sessionId: "sess-acp",
          updatedAt: 100,
        },
      });

      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey: rawSessionKey,
        now: () => 200,
        mutate: () => createMeta("codex-normalized"),
      });

      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey: rawSessionKey,
        })?.acp?.runtimeSessionName,
      ).toBe("codex-normalized");
      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey: storeSessionKey,
        })?.acp?.runtimeSessionName,
      ).toBe("codex-normalized");
      expect(
        readAcpSessionEntry({ cfg, databasePath, sessionKey: `  ${rawSessionKey}  ` })?.acp
          ?.runtimeSessionName,
      ).toBe("codex-normalized");
      expect(fs.existsSync(storePath)).toBe(false);
      const legacyEmbeddedEntry = readStoredAcpSessionEntry({
        storePath,
        sessionKey: storeSessionKey,
      });
      expect(legacyEmbeddedEntry).toBeDefined();
      if (!legacyEmbeddedEntry) {
        throw new Error("expected normalized ACP session entry");
      }
      await seedAcpSessionEntry({
        storePath,
        sessionKey: storeSessionKey,
        entry: {
          ...legacyEmbeddedEntry,
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "legacy-embedded",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 120,
          },
        },
      });

      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey: rawSessionKey,
        mutate: (current) => {
          expect(current?.runtimeSessionName).toBe("codex-normalized");
          return null;
        },
      });

      expect(
        readAcpSessionEntry({
          cfg,
          databasePath,
          sessionKey: storeSessionKey,
        })?.acp,
      ).toBeUndefined();
      expect(
        readStoredAcpSessionEntry({ storePath, sessionKey: storeSessionKey })?.acp,
      ).toBeUndefined();
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
        },
      });

      await upsertAcpSessionMeta({
        cfg,
        databasePath,
        sessionKey: legacyStoreSessionKey,
        now: () => 200,
        mutate: () => createMeta("codex-alias"),
      });

      expect(
        readStoredAcpSessionEntry({ storePath, sessionKey: canonicalSessionKey })?.sessionId,
      ).toBe("sess-legacy");
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

  it("reads ACP metadata rows written with the legacy session-id binding", async () => {
    await withTestDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const databasePath = path.join(dir, "state", "openclaw.sqlite");
      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const sessionKey = "agent:codex:acp:binding:discord:default:legacy";
      await seedAcpSessionEntry({
        storePath,
        sessionKey,
        entry: {
          sessionId: "sess-existing",
          lifecycleRevision: "revision-existing",
          sessionStartedAt: 50,
          updatedAt: 100,
        },
      });
      // Simulate the pre-boundary layout, where session_id stored the logical id.
      writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey: buildAcpDatabaseSessionKey(sessionKey, ACP_AGENT_ID),
        lifecycleRevision: "sess-existing",
        now: () => 100,
        meta: createMeta("codex-legacy"),
      });

      expect(readAcpSessionEntry({ cfg, databasePath, sessionKey })?.acp?.runtimeSessionName).toBe(
        "codex-legacy",
      );
      expect(await listAcpSessionEntries({ cfg, databasePath })).toHaveLength(1);
      expect(
        readAcpSessionMetaForEntry({
          databasePath,
          sessionKey,
          agentId: ACP_AGENT_ID,
          entry: {
            sessionId: "sess-existing",
            lifecycleRevision: "revision-next",
            sessionStartedAt: 150,
          },
        }),
      ).toBeUndefined();

      const staleKey = `${sessionKey}:stale`;
      await seedAcpSessionEntry({
        storePath,
        sessionKey: staleKey,
        entry: {
          sessionId: "sess-stale",
          lifecycleRevision: "revision-after-reset",
          sessionStartedAt: 150,
          updatedAt: 150,
        },
      });
      writeAcpSessionMetaForMigration({
        databasePath,
        sessionKey: buildAcpDatabaseSessionKey(staleKey, ACP_AGENT_ID),
        lifecycleRevision: "sess-stale",
        now: () => 100,
        meta: createMeta("codex-stale-legacy", { lastActivityAt: 100 }),
      });
      expect(readAcpSessionEntry({ cfg, databasePath, sessionKey: staleKey })?.acp).toBeUndefined();
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

  it.each([
    "agent:codex:acp:binding:configured",
    "agent:codex:ordinary",
    "acp:bare",
    "@acp:v1:literal",
  ])("does not case-fold metadata outside free ACP keys: %s", async (sessionKey) => {
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
      expect(
        readAcpSessionMetaBatch({ databasePath, entries: [{ sessionKey, entry }] }).get(entry),
      ).toBeUndefined();
    });
  });
});
