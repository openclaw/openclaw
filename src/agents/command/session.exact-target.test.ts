import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolveInternalSessionEffectsIdentity } from "../../config/sessions/internal-session-key.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  inspectOpenClawAgentDatabaseOwner,
  isOpenClawAgentDatabaseOpen,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSession, resolveSessionKeyForRequestCore } from "./session.js";

it("resolves a partitioned global session id with legacy ownership", async () => {
  const sessionKey = "global";
  await withOpenClawTestState({ label: "command-partitioned-session-id" }, async (state) => {
    const storePath = state.statePath("sessions.json");
    const agentIds = ["main", "ops"];
    const cfg: OpenClawConfig = {
      agents: {
        entries: Object.fromEntries(agentIds.map((agentId) => [agentId, {}])),
      },
      session: { store: storePath },
    };
    retainLegacyDefaultAgentId(cfg, "main");
    for (const agentId of ["main", "ops"]) {
      await sessionAccessor.replaceSessionEntry(
        { agentId, sessionKey, storePath },
        { sessionId: `${agentId}-session`, updatedAt: Date.now(), label: agentId },
      );
    }

    expect(resolveSessionKeyForRequestCore({ cfg, sessionId: "ops-session" })).toMatchObject({
      agentId: "ops",
      sessionKey,
      storePath,
      sessionEntry: { sessionId: "ops-session", label: "ops" },
    });
  });
});

it("keeps exact shared SQLite ownership separate from the scan agent and physical owner", async () => {
  await withOpenClawTestState({ label: "command-shared-session-id" }, async (state) => {
    const storePath = state.statePath("shared.sqlite");
    await sessionAccessor.replaceSessionEntry(
      { agentId: "main", sessionKey: "global", storePath },
      { sessionId: "unscoped-session", updatedAt: Date.now() },
    );
    await sessionAccessor.replaceSessionEntry(
      { agentId: "ops", sessionKey: "agent:ops:work", storePath },
      { sessionId: "scoped-session", updatedAt: Date.now() },
    );
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { ops: {}, main: {} } },
      session: { store: storePath },
    };

    expect(() =>
      resolveSessionKeyForRequestCore({ cfg, sessionId: "unscoped-session" }),
    ).toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
    expect(resolveSessionKeyForRequestCore({ cfg, sessionId: "scoped-session" })).toMatchObject({
      agentId: "ops",
      sessionKey: "agent:ops:work",
      storePath,
    });
    for (const owner of ["ops", "retired"]) {
      const ownedCfg: OpenClawConfig = {
        ...cfg,
        agents: { ...cfg.agents, defaults: { sessionStore: { agentId: owner } } },
      };
      if (owner === "retired") {
        expect(() =>
          resolveSessionKeyForRequestCore({ cfg: ownedCfg, sessionId: "unscoped-session" }),
        ).toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
      } else {
        expect(
          resolveSessionKeyForRequestCore({ cfg: ownedCfg, sessionId: "unscoped-session" }),
        ).toMatchObject({ agentId: "ops", sessionKey: "global", storePath });
      }
    }
    expect(inspectOpenClawAgentDatabaseOwner(storePath)).toEqual({
      status: "owned",
      agentId: "main",
    });
  });
});

it.each(["work", "dashboard:incognito-work"])(
  "resolves the exact %s session without enumerating unrelated rows",
  async (key) => {
    await withOpenClawTestState({ label: "command-exact-session" }, async (state) => {
      const storePath = state.statePath("sessions.sqlite");
      const sessionKey = `agent:main:${key}`;
      const incognito = key.startsWith("dashboard:incognito-");
      const cfg = {
        agents: { defaults: {} },
        session: { store: storePath, reset: { mode: "idle", idleMinutes: 60 } },
      } satisfies OpenClawConfig;
      const entry = {
        sessionId: "selected-session",
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
      await sessionAccessor.replaceSessionEntry({ sessionKey, storePath }, entry);
      const persisted = sessionAccessor.loadExactSessionEntryReadOnly({
        sessionKey,
        storePath,
      })?.entry;
      expect(persisted).toMatchObject({
        thinkingLevel: "high",
        modelOverride: "gpt-5.6-luna",
        providerOverride: "openai",
        lifecycleRevision: expect.any(String),
      });
      if (!incognito) {
        await sessionAccessor.replaceSessionEntry(
          { sessionKey: "agent:main:unrelated", storePath },
          { sessionId: "unrelated-session", updatedAt: Date.now() },
        );
      }
      const list = vi.spyOn(sessionAccessor, "listSessionEntriesReadOnly");
      try {
        const resolved = await resolveSession({ cfg, sessionKey });
        expect(resolved).toMatchObject({
          sessionId: entry.sessionId,
          sessionKey,
          isNewSession: false,
          persistedThinking: "high",
          sessionEntry: persisted,
        });
        if (!resolved.sessionEntry?.skillsSnapshot) {
          throw new Error("expected the selected session's skills");
        }
        resolved.sessionEntry.skillsSnapshot.prompt = "caller-owned edit";
        expect(
          sessionAccessor.loadExactSessionEntryReadOnly({ sessionKey, storePath })?.entry
            .skillsSnapshot?.prompt,
        ).toBe("selected prompt");
        expect(list).not.toHaveBeenCalled();
        if (incognito) {
          expect(fs.existsSync(storePath)).toBe(false);
        }
      } finally {
        list.mockRestore();
      }
    });
  },
);

it.each(["agent:main:assist:01M21F31SCNCCQQ3N4X43AY420", "agent:main:signal:group:AbCdEf123"])(
  "reuses the persisted session for explicit key %s",
  async (sessionKey) => {
    await withOpenClawTestState({ label: "command-uppercase-tail-session" }, async (state) => {
      const storePath = state.statePath("sessions.sqlite");
      const cfg = {
        agents: { defaults: {} },
        session: { store: storePath, reset: { mode: "idle", idleMinutes: 60 } },
      } satisfies OpenClawConfig;

      const first = await resolveSession({ cfg, sessionKey });
      expect(first.sessionEntry).toBeUndefined();
      expect(first.isNewSession).toBe(true);
      await sessionAccessor.replaceSessionEntry(
        { sessionKey, storePath },
        { sessionId: first.sessionId, updatedAt: Date.now(), sessionStartedAt: Date.now() },
      );

      const second = await resolveSession({ cfg, sessionKey });
      expect(second.sessionKey).toBe(sessionKey);
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.isNewSession).toBe(false);
      expect(second.sessionEntry?.sessionId).toBe(first.sessionId);
    });
  },
);

it("does not provision a missing incognito lookup or select a hidden run-owned entry", async () => {
  await withOpenClawTestState({ label: "command-private-session" }, async (state) => {
    const storePath = state.statePath("sessions.sqlite");
    const cfg = { agents: { defaults: {} }, session: { store: storePath } };
    const incognitoPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    expect(
      resolveSessionKeyForRequestCore({ cfg, sessionKey: "agent:main:dashboard:incognito-missing" })
        .sessionEntry,
    ).toBeUndefined();
    expect(isOpenClawAgentDatabaseOpen(incognitoPath)).toBe(false);
    expect(fs.existsSync(storePath)).toBe(false);

    const hidden = resolveInternalSessionEffectsIdentity({ agentId: "main", runId: "hidden-run" });
    await sessionAccessor.replaceSessionEntry(
      { sessionKey: hidden.sessionKey, storePath },
      { sessionId: hidden.sessionId, updatedAt: Date.now() },
    );
    expect(
      resolveSessionKeyForRequestCore({ cfg, sessionKey: hidden.sessionKey }).sessionEntry,
    ).toBeUndefined();
    expect(
      resolveSessionKeyForRequestCore({ cfg, sessionKey: hidden.sessionKey.toUpperCase() })
        .sessionEntry,
    ).toBeUndefined();
  });
});
