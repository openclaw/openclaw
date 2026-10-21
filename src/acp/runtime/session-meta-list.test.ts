import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { seedCanonicalAcpSessionMeta } from "./session-meta-fixture.test-support.js";
import { createAcpMeta } from "./session-meta-lifecycle.test-support.js";
import { listAcpSessionEntries, upsertAcpSessionMeta } from "./session-meta.js";
import { withAcpSessionTestDir as withTestDir } from "./session-meta.test-support.js";

function meta(runtimeSessionName: string, overrides: Partial<SessionAcpMeta> = {}): SessionAcpMeta {
  return createAcpMeta({ backend: "acpx", agent: "codex", runtimeSessionName, ...overrides });
}

type Scope = Parameters<typeof listAcpSessionEntries>[0] & { storePath?: string };
async function seed(scope: Scope, key: string, entry: SessionEntry, acp: SessionAcpMeta) {
  await replaceSessionEntry({ ...scope, agentId: "codex", sessionKey: key }, entry);
  await upsertAcpSessionMeta({ ...scope, sessionKey: key, mutate: () => acp });
}

async function listWithoutHostSql(scope: Parameters<typeof listAcpSessionEntries>[0]) {
  const sql = observeMainThreadSql();
  try {
    const entries = await listAcpSessionEntries(scope);
    sql.expectIdle();
    return entries;
  } finally {
    sql.restore();
  }
}

it("lists SQLite ACP rows while joining current session-store entries", async () => {
  await withTestDir({ prefix: "openclaw-acp-meta-" }, async (dir) => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const storePath = path.join(dir, "agents", "codex", "sessions", "sessions.json");
    const databasePath = path.join(dir, "state", "openclaw.sqlite");
    const scope = { cfg: {}, env, databasePath };
    const sessionKey = "agent:codex:acp:s1";
    const saved = {
      sessionId: "sess-acp",
      model: "gpt-5.5",
      skillsSnapshot: { prompt: "Saved prompt", skills: [{ name: "fixture-skill" }] },
    };
    const acp = meta("codex-s1", { mode: "oneshot", state: "running", lastActivityAt: 321 });
    await seed({ ...scope, storePath }, sessionKey, { ...saved, updatedAt: 100 }, acp);

    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    const entries = await listWithoutHostSql(scope);
    expect(entries).toMatchObject([
      {
        cfg: scope.cfg,
        storePath,
        sessionKey,
        storeSessionKey: sessionKey,
        entry: saved,
        acp,
      },
    ]);
    const snapshot = entries[0]?.entry?.skillsSnapshot;
    if (!snapshot) {
      throw new Error("Expected complete session metadata");
    }
    for (const value of [snapshot, snapshot.skills, snapshot.skills[0]]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => {
      snapshot.skills[0]!.name = "changed-return-value";
    }).toThrow(TypeError);
    await upsertAcpSessionMeta({
      ...scope,
      sessionKey,
      mutate: (current) => current && { ...current, runtimeSessionName: "updated-runtime" },
    });
    const fresh = await listAcpSessionEntries(scope);
    expect(fresh[0]).toMatchObject({
      entry: { skillsSnapshot: { skills: [{ name: "fixture-skill" }] } },
      acp: { runtimeSessionName: "updated-runtime" },
    });
  });
});

it("loads cold runtime config and joins entries without main-thread SQL", async () => {
  await withOpenClawTestState({ label: "acp-list-cold-config" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { codex: {} } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:codex:acp:cold-config";
    await seed(
      { cfg, env: state.env },
      sessionKey,
      { sessionId: "cold-config", updatedAt: 100 },
      meta("cold-config"),
    );
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    resetConfigRuntimeState();
    expect(await listWithoutHostSql({})).toMatchObject([
      {
        sessionKey,
        entry: { sessionId: "cold-config" },
        acp: { runtimeSessionName: "cold-config" },
      },
    ]);
  });
});

it.each(["state", "agent"] as const)("does not create a missing %s store", async (missing) => {
  await withTestDir({ prefix: "openclaw-acp-list-missing-" }, async (dir) => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(dir, "missing") };
    if (missing === "agent") {
      seedCanonicalAcpSessionMeta({
        env,
        sessionKey: "agent:codex:acp:missing",
        sessionId: "missing",
        meta: meta("missing"),
      });
      await closeOpenClawStateDatabaseAsync();
    }
    expect(await listWithoutHostSql({ cfg: {}, env })).toEqual([]);
    expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR, "agents"))).toBe(false);
    if (missing === "state") {
      expect(fs.existsSync(env.OPENCLAW_STATE_DIR)).toBe(false);
    }
  });
});
