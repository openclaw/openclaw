import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { failSessionActorMemoryPublication } from "../../config/sessions/session-actor-memory-publication.test-support.js";
import type { InternalSessionEntry, SessionAcpMeta } from "../../config/sessions/types.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withoutMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareAcpSessionControlRead } from "./session-meta-control.js";
import { seedCanonicalAcpSessionMeta } from "./session-meta-fixture.test-support.js";
import { createAcpMeta } from "./session-meta-lifecycle.test-support.js";
import { acquireAcpMemorySession } from "./session-meta-memory.js";
import { readAcpSessionEntryAsync } from "./session-meta-read.js";
import {
  listAcpSessionEntries,
  readAcpSessionEntry,
  upsertAcpSessionMeta,
} from "./session-meta.js";
import { withAcpSessionTestDir as withTestDir } from "./session-meta.test-support.js";

function createMeta(name: string, overrides: Partial<SessionAcpMeta> = {}) {
  return createAcpMeta({ backend: "acpx", agent: "codex", runtimeSessionName: name, ...overrides });
}

const listWithoutHostSql = (scope: Parameters<typeof listAcpSessionEntries>[0]) =>
  withoutMainThreadSql(() => listAcpSessionEntries(scope));

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
    const acp = createMeta("codex-s1", { mode: "oneshot", state: "running", lastActivityAt: 321 });
    await replaceSessionEntry(
      { ...scope, storePath, agentId: "codex", sessionKey },
      { ...saved, updatedAt: 100 },
    );
    await upsertAcpSessionMeta({ ...scope, sessionKey, mutate: () => acp });

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
        meta: createMeta("missing"),
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

function memoryScope(env: NodeJS.ProcessEnv, sessionKey: string) {
  const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
  return { cfg, env, agentId: "main", sessionKey };
}
const entry = {
  sessionId: "session",
  lifecycleRevision: "lifecycle",
  updatedAt: 100,
  incognito: true,
} satisfies InternalSessionEntry;

it("settles shared ACP metadata before reporting the committed entry publication failure", () =>
  withOpenClawTestState({ label: "acp-memory-publication" }, async (state) => {
    const scope = memoryScope(state.env, "agent:main:dashboard:incognito-acp-publication");
    await replaceSessionEntry(scope, { ...entry });
    const meta = createAcpMeta({ agent: "fixture", runtimeSessionName: "saved-runtime" });
    using cleanup = new DisposableStack();
    cleanup.defer(failSessionActorMemoryPublication(scope.sessionKey));
    await expect(upsertAcpSessionMeta({ ...scope, mutate: () => meta })).rejects.toMatchObject({
      name: "SessionActorStorageCommittedError",
    });
    expect((await readAcpSessionEntryAsync(scope))?.acp).toEqual(meta);
  }));

it("acquires unbound actor entries and joins shared ACP receipts at the control effect without host SQL", () =>
  withOpenClawTestState({ label: "acp-memory-control" }, async (state) => {
    const scope = memoryScope(state.env, "agent:main:dashboard:incognito-acp");
    const { cfg, sessionKey } = scope;
    const actorPath = resolveIncognitoOpenClawAgentSqlitePath(scope);
    const ownerScope = { agentId: "main", path: actorPath };
    expect(() => readAcpSessionEntry(scope)).toThrow(/readAcpSessionEntryAsync/);
    expect(await readAcpSessionEntryAsync(scope)).toBeNull();
    expect(memorySessionActorOwners.read(ownerScope)).toBeUndefined();
    await replaceSessionEntry(scope, { ...entry, spawnedBy: "agent:main:parent" });
    const binding = await acquireAcpMemorySession(scope);
    assert(binding, "Expected the created memory actor");
    const { actor, authority } = binding;
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => memorySessionActorOwners.closeDatabase(ownerScope));
    cleanup.defer(() => actor.release());
    const meta = createAcpMeta({ agent: "fixture", runtimeSessionName: "first-runtime" });
    const patchLabel = (label: string) =>
      actor.storage.mutate(
        {
          type: "session.entry.patch",
          input: { operation: { kind: "fields", patch: { label } } },
        },
        authority,
      );
    await upsertAcpSessionMeta({ ...scope, mutate: () => meta });
    const observe = observeHostDataSql();
    cleanup.defer(observe.restore);
    expect(actor.snapshot(authority)?.entry?.acp).toBeUndefined();
    const alias = { ...scope, sessionKey: ` ${sessionKey.toUpperCase()} ` };
    expect((await readAcpSessionEntryAsync(alias))?.acp).toMatchObject(meta);
    const control = await prepareAcpSessionControlRead(scope);
    cleanup.defer(() => control.release());
    control.initialRead.session.acp!.runtimeSessionName = "caller-edited-output";
    control.assertAcpCurrent?.(cfg, meta);
    const nextMeta = { ...meta, runtimeSessionName: "second-runtime" };
    await upsertAcpSessionMeta({
      ...scope,
      assertCommitAllowed: () => control?.assertAcpCurrent?.(cfg, meta),
      mutate: () => {
        void patchLabel("concurrent-label");
        return nextMeta;
      },
    });
    expect(actor.snapshot(authority)?.entry?.label).toBe("concurrent-label");
    expect(() => control?.assertAcpCurrent?.(cfg, meta)).toThrow(/locator changed/);
    control.assertAcpCurrent?.(cfg, nextMeta);
    expect((await control.readCurrent(cfg)).session.acp).toMatchObject(nextMeta);
    await upsertAcpSessionMeta({
      ...scope,
      assertCommitAllowed: () => control?.assertAcpCurrent?.(cfg, nextMeta),
      mutate: () => null,
    });
    expect(() => control?.assertAcpCurrent?.(cfg, nextMeta)).toThrow(/locator changed/);
    expect((await readAcpSessionEntryAsync(scope))?.acp).toBeUndefined();
    memorySessionActorOwners.closeSession(ownerScope, sessionKey);
    expect(() => control?.assertCurrent(cfg)).toThrow();
    expect(observe.queries).toEqual([]);
    expect(fs.existsSync(actorPath)).toBe(false);
  }));
