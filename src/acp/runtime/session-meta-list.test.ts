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

it("joins immutable current entries with explicit context and after a cold config reload", () =>
  withOpenClawTestState({ label: "acp-list" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { codex: {} } } };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const storePath = path.join(state.sessionsDir("codex"), "sessions.json");
    const scope = { cfg, env: state.env, databasePath: state.statePath("openclaw.sqlite") };
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
    const expected = { cfg, storePath, sessionKey, storeSessionKey: sessionKey, entry: saved, acp };
    expect(entries).toMatchObject([expected]);
    const snapshot = entries[0]!.entry!.skillsSnapshot!;
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
    const updated = { ...expected, acp: { ...acp, runtimeSessionName: "updated-runtime" } };
    expect(await listWithoutHostSql(scope)).toMatchObject([updated]);
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    resetConfigRuntimeState();
    expect(await listWithoutHostSql({})).toMatchObject([updated]);
  }));

it.each(["state", "agent"] as const)("does not create a missing %s store", (missing) =>
  withTestDir({ prefix: "openclaw-acp-list-missing-" }, async (dir) => {
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
  }),
);
