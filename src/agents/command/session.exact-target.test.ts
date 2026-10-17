import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolveInternalSessionEffectsIdentity } from "../../config/sessions/internal-session-key.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  inspectOpenClawAgentDatabaseOwner,
  isOpenClawAgentDatabaseOpen,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  resolveSession,
  resolveSessionKeyForRequestCore,
  resolveStoredSessionKeyForSessionId,
} from "./session.js";

function sessionFixture(state: OpenClawTestState, filename = "sessions.sqlite") {
  const storePath = state.statePath(filename);
  const cfg: OpenClawConfig = { agents: { defaults: {} }, session: { store: storePath } };
  return {
    cfg,
    storePath,
    put: (
      sessionKey: string,
      sessionId: string,
      extra: Partial<SessionEntry> = {},
      agentId?: string,
    ) =>
      sessionAccessor.replaceSessionEntry(
        { sessionKey, storePath, ...(agentId ? { agentId } : {}) },
        { sessionId, updatedAt: Date.now(), ...extra },
      ),
    lookup: (
      request: Omit<Parameters<typeof resolveSessionKeyForRequestCore>[0], "cfg">,
      config = cfg,
    ) => resolveSessionKeyForRequestCore({ cfg: config, ...request }),
    resolve: (sessionKey: string) => resolveSession({ cfg, sessionKey }),
  };
}

it("resolves session IDs without loading unrelated saved snapshots", async () => {
  await withOpenClawTestState({ label: "command-bounded-session-id" }, async (state) => {
    const { cfg, storePath, put } = sessionFixture(state);
    const sessionKey = "agent:main:selected";
    cfg.agents = { entries: { main: {} } };
    for (const name of ["selected", "unrelated"]) {
      await put(
        `agent:main:${name}`,
        `${name}-id`,
        { updatedAt: 1, skillsSnapshot: { prompt: `${name} prompt`, skills: [] } },
        "main",
      );
    }
    await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
    const database = openNodeSqliteDatabase(storePath);
    try {
      // A cold payload that cannot be parsed proves the lookup never materializes that row.
      database
        .prepare("UPDATE session_entry_snapshots SET value_json = ? WHERE session_key = ?")
        .run("{", "agent:main:unrelated");
    } finally {
      database.close();
    }
    for (const resolve of [resolveStoredSessionKeyForSessionId, resolveSessionKeyForRequestCore]) {
      expect(await resolve({ cfg, agentId: "main", sessionId: "selected-id" })).toMatchObject({
        agentId: "main",
        sessionKey,
        sessionEntry: { skillsSnapshot: { prompt: "selected prompt", skills: [] } },
      });
    }
    await expect(
      resolveStoredSessionKeyForSessionId({ cfg, agentId: "main", sessionId: "unrelated-id" }),
    ).rejects.toThrow();
  });
});

it("resolves a partitioned global session id with legacy ownership", async () => {
  const sessionKey = "global";
  await withOpenClawTestState({ label: "command-partitioned-session-id" }, async (state) => {
    const { cfg, storePath, put, lookup } = sessionFixture(state, "sessions.json");
    cfg.agents = { entries: { main: {}, ops: {} } };
    retainLegacyDefaultAgentId(cfg, "main");
    for (const agentId of ["main", "ops"]) {
      await put(sessionKey, `${agentId}-session`, { label: agentId }, agentId);
    }

    expect(await lookup({ sessionId: "ops-session" })).toMatchObject({
      agentId: "ops",
      sessionKey,
      storePath,
      sessionEntry: { sessionId: "ops-session", label: "ops" },
    });
  });
});

it("keeps exact shared SQLite ownership separate from the scan agent and physical owner", async () => {
  await withOpenClawTestState({ label: "command-shared-session-id" }, async (state) => {
    const { cfg, storePath, put, lookup } = sessionFixture(state, "shared.sqlite");
    cfg.agents = { ownership: "explicit", entries: { ops: {}, main: {} } };
    for (const [agentId, sessionKey, sessionId] of [
      ["main", "global", "unscoped-session"],
      ["ops", "agent:ops:work", "scoped-session"],
    ] as const) {
      await put(sessionKey, sessionId, {}, agentId);
    }

    const ownershipError = expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" });
    await expect(lookup({ sessionId: "unscoped-session" })).rejects.toThrowError(ownershipError);
    expect(await lookup({ sessionId: "scoped-session" })).toMatchObject({
      agentId: "ops",
      sessionKey: "agent:ops:work",
      storePath,
    });
    const lookupWithOwner = (agentId: string) =>
      lookup(
        { sessionId: "unscoped-session" },
        {
          ...cfg,
          agents: { ...cfg.agents, defaults: { sessionStore: { agentId } } },
        },
      );
    expect(await lookupWithOwner("ops")).toMatchObject({
      agentId: "ops",
      sessionKey: "global",
      storePath,
    });
    await expect(lookupWithOwner("retired")).rejects.toThrowError(ownershipError);
    expect(inspectOpenClawAgentDatabaseOwner(storePath)).toEqual({
      status: "owned",
      agentId: "main",
    });
  });
});

it.each([
  ["work", false],
  ["dashboard:incognito-work", false],
  ["assist:01M21F31SCNCCQQ3N4X43AY420", true],
  ["signal:group:AbCdEf123", true],
] as const)(
  "reuses the exact %s session without enumerating unrelated rows",
  async (key, createMissing) => {
    await withOpenClawTestState({ label: "command-exact-session" }, async (state) => {
      const { cfg, storePath, put, resolve } = sessionFixture(state);
      const sessionKey = `agent:main:${key}`;
      const incognito = key.startsWith("dashboard:incognito-");
      cfg.session!.reset = { mode: "idle", idleMinutes: 60 };
      const first = createMissing ? await resolve(sessionKey) : { sessionId: "selected-session" };
      if (createMissing) {
        expect(first).toMatchObject({ sessionEntry: undefined, isNewSession: true });
      }
      const entry = {
        sessionId: first.sessionId,
        updatedAt: Date.now(),
        sessionStartedAt: Date.now(),
        lastInteractionAt: Date.now(),
        thinkingLevel: "high",
        modelOverride: "gpt-5.6-luna",
        providerOverride: "openai",
        lifecycleRevision: "selected-revision",
        skillsSnapshot: { prompt: "selected prompt", skills: [] },
        ...(incognito ? { incognito: true as const } : {}),
      };
      await put(
        sessionKey,
        entry.sessionId,
        createMissing ? { sessionStartedAt: entry.sessionStartedAt } : entry,
      );
      const persisted = sessionAccessor.loadExactSessionEntryReadOnly({
        sessionKey,
        storePath,
      })?.entry;
      expect(persisted?.sessionId).toBe(entry.sessionId);
      if (!createMissing) {
        expect(persisted).toMatchObject({
          thinkingLevel: "high",
          modelOverride: "gpt-5.6-luna",
          providerOverride: "openai",
          lifecycleRevision: expect.any(String),
        });
      }
      if (!incognito) {
        await put("agent:main:unrelated", "unrelated-session");
      }
      const list = vi.spyOn(sessionAccessor, "listSessionEntriesReadOnly");
      try {
        const resolved = await resolve(sessionKey);
        expect(resolved).toMatchObject({
          sessionId: entry.sessionId,
          sessionKey,
          isNewSession: false,
          ...(createMissing ? {} : { persistedThinking: "high" }),
          sessionEntry: persisted,
        });
        expect(list).not.toHaveBeenCalled();
        if (incognito) {
          const incognitoPath = resolveIncognitoOpenClawAgentSqlitePath({
            agentId: "main",
            env: state.env,
          });
          expect([storePath, incognitoPath].map((file) => fs.existsSync(file))).toEqual([
            false,
            false,
          ]);
        }
      } finally {
        list.mockRestore();
      }
    });
  },
);

it("does not provision a missing incognito lookup or select a hidden run-owned entry", async () => {
  await withOpenClawTestState({ label: "command-private-session" }, async (state) => {
    const { storePath, put, lookup } = sessionFixture(state);
    const incognitoPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    expect(
      (await lookup({ sessionKey: "agent:main:dashboard:incognito-missing" })).sessionEntry,
    ).toBeUndefined();
    expect(isOpenClawAgentDatabaseOpen(incognitoPath)).toBe(false);
    expect(fs.existsSync(storePath)).toBe(false);

    const hidden = resolveInternalSessionEffectsIdentity({ agentId: "main", runId: "hidden-run" });
    await put(hidden.sessionKey, hidden.sessionId);
    for (const sessionKey of [hidden.sessionKey, hidden.sessionKey.toUpperCase()]) {
      expect((await lookup({ sessionKey })).sessionEntry).toBeUndefined();
    }
  });
});
