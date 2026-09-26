import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readLegacyAcpMigrationContext } from "../../config/sessions/session-accessor.sqlite-acp-provenance.js";
import * as historyMaintenance from "../../config/sessions/session-history-eviction.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as entryWorker from "./session-meta-entry.js";
import { buildAcpDatabaseSessionKey } from "./session-meta-keys.js";
import { upsertAcpSessionMeta } from "./session-meta-write.js";
import { readAcpSessionMeta, writeAcpSessionMetaForMigration } from "./session-meta.js";

const META: SessionAcpMeta = {
  backend: "fixture-backend",
  agent: "fixture-agent",
  runtimeSessionName: "worker-session",
  mode: "persistent",
  state: "idle",
  lastActivityAt: 100,
};

it("preserves incognito entry mutations without spilling the process-held session to disk", async () => {
  await withOpenClawTestState({ label: "acp-write-incognito" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
    const scope = {
      cfg,
      env: state.env,
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-private",
      skipMaintenance: true,
    };
    await replaceSessionEntry(scope, {
      sessionId: "private-session",
      lifecycleRevision: "private-revision",
      updatedAt: 100,
      label: "private-session-label",
      skillsSnapshot: { prompt: "private-session-prompt", skills: [] },
    });
    const initial = loadExactSessionEntry(scope)?.entry;
    if (!initial) {
      throw new Error("Expected the process-held incognito entry");
    }
    const paths = [
      resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
      resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
    ].flatMap((database) => [database, `${database}-wal`, `${database}-shm`]);
    paths.push(path.join(state.sessionsDir("main"), "sessions.json"));
    expect(paths.filter((filename) => fs.existsSync(filename))).toEqual([]);
    const set = await upsertAcpSessionMeta({ ...scope, mutate: () => META });
    expect(set?.acp).toEqual(META);
    expect(readAcpSessionMeta(scope)).toEqual(META);
    const updatedMeta = { ...META, state: "running" as const, lastActivityAt: 200 };
    const update = await upsertAcpSessionMeta({
      ...scope,
      mutate: (current) => {
        expect(current).toEqual(META);
        return updatedMeta;
      },
    });
    expect(update?.acp).toEqual(updatedMeta);
    expect(readAcpSessionMeta(scope)).toEqual(updatedMeta);
    const cleared = await upsertAcpSessionMeta({ ...scope, mutate: () => null });
    expect(cleared?.acp).toBeUndefined();
    expect(readAcpSessionMeta(scope)).toBeUndefined();
    expect(loadExactSessionEntry(scope)?.entry).toMatchObject({
      sessionId: initial.sessionId,
      lifecycleRevision: initial.lifecycleRevision,
      label: initial.label,
      skillsSnapshot: initial.skillsSnapshot,
    });
    expect(loadExactSessionEntry(scope)?.entry.acp).toBeUndefined();
    expect(paths.filter((filename) => fs.existsSync(filename))).toEqual([]);
  });
});

it("creates, updates, and closes file-backed ACP metadata without host data SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal", label: "acp-write-worker" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
    await state.writeConfig({ ...cfg, session: { maintenance: { mode: "warn", maxEntries: 37 } } });
    const scope = {
      cfg,
      env: state.env,
      agentId: "main",
      sessionKey: "agent:main:acp:worker",
      skipMaintenance: true,
    };
    const observe = observeHostDataSql(state.env);
    const maintenance = vi.spyOn(historyMaintenance, "kickSessionHistoryDiskBudgetMaintenance");
    const initialize = vi.fn(() => META);
    const update = vi.fn((current: SessionAcpMeta | undefined) => {
      if (!current) {
        throw new Error("Expected initialized ACP metadata");
      }
      return { ...current, state: "running" as const };
    });
    try {
      const created = await upsertAcpSessionMeta({ ...scope, mutate: initialize });
      expect(created?.acp).toEqual(META);
      const updated = await upsertAcpSessionMeta({ ...scope, mutate: update });
      expect(updated?.acp?.state).toBe("running");
      expect(initialize).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledOnce();
      expect(update.mock.calls[0]?.[0]).toEqual(META);
      await upsertAcpSessionMeta({ ...scope, mutate: () => null });
      expect(observe.queries).toEqual([]);
      expect(maintenance.mock.calls.length).toBeGreaterThan(0);
      expect(
        maintenance.mock.calls.every(([input]) => input.maintenanceConfig?.maxEntries === 37),
      ).toBe(true);
    } finally {
      observe.restore();
      maintenance.mockRestore();
    }
    expect(readAcpSessionMeta(scope)).toBeUndefined();
    const persisted = loadExactSessionEntry(scope)?.entry;
    expect(persisted?.sessionId).toBeTruthy();
    expect(persisted?.acp).toBeUndefined();
    expect(
      openOpenClawStateDatabase({ env: state.env })
        .db.prepare("SELECT count(*) AS count FROM acp_sessions")
        .get(),
    ).toEqual({ count: 0 });
  });
});

it.each([
  ["before-touch", "session-id"],
  ["before-touch", "lifecycle-revision"],
  ["before-touch", "control-owner"],
  ["after-cleanup", "session-id"],
  ["after-cleanup", "lifecycle-revision"],
  ["after-cleanup", "control-owner"],
] as const)(
  "rejects a %s replacement of %s without changing its ACP binding",
  async (boundary, replacement) => {
    await withOpenClawTestState(
      { scenario: "minimal", label: `acp-write-${boundary}-${replacement}` },
      async (state) => {
        const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
        await state.writeConfig(cfg);
        const scope = {
          cfg,
          env: state.env,
          agentId: "main",
          sessionKey: "agent:main:acp:lifecycle-race",
          skipMaintenance: true,
        };
        await replaceSessionEntry(scope, {
          sessionId: "initial-session",
          lifecycleRevision: "initial-revision",
          spawnedBy: "agent:main:owner",
          updatedAt: 100,
        });
        await upsertAcpSessionMeta({ ...scope, mutate: () => META });
        const originalEntry = loadExactSessionEntry(scope)?.entry;
        if (!originalEntry) {
          throw new Error("Expected the original ACP lifecycle");
        }
        expect(readLegacyAcpMigrationContext(scope).sources).toEqual([]);
        const reached = createDeferredCore();
        const release = createDeferredCore();
        const original = entryWorker.updateAcpSessionStoreEntry;
        let paused = false;
        const intercepted = vi
          .spyOn(entryWorker, "updateAcpSessionStoreEntry")
          .mockImplementation(async (input) => {
            if (!paused && boundary === "before-touch" && input.mutation.kind === "touch") {
              paused = true;
              reached.resolve();
              await release.promise;
            }
            const result = await original(input);
            if (!paused && boundary === "after-cleanup" && input.mutation.kind === "clear-legacy") {
              paused = true;
              reached.resolve();
              await release.promise;
            }
            return result;
          });
        const mutate = vi.fn(() => ({ ...META, runtimeSessionName: "obsolete-update" }));
        const expectedControlBinding =
          replacement === "control-owner"
            ? {
                sessionId: originalEntry.sessionId,
                lifecycleRevision: originalEntry.lifecycleRevision,
                sessionStartedAt: originalEntry.sessionStartedAt,
                ownerKey: "agent:main:owner",
              }
            : undefined;
        const updating = upsertAcpSessionMeta({
          ...scope,
          mutate,
          expectedControlBinding,
        });
        // Keep early rejection observable without leaving a blocked fixture or an unhandled promise.
        const outcome = updating.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          await Promise.race([
            reached.promise,
            outcome.then(() => {
              throw new Error("ACP update settled before the requested mutation boundary");
            }),
          ]);
          const next = {
            ...originalEntry,
            sessionId:
              replacement === "session-id" ? "replacement-session" : originalEntry.sessionId,
            lifecycleRevision:
              replacement === "lifecycle-revision"
                ? "replacement-revision"
                : originalEntry.lifecycleRevision,
            updatedAt: 200,
            label: "replacement-owner",
            spawnedBy:
              replacement === "control-owner" ? "agent:main:new-owner" : originalEntry.spawnedBy,
          };
          await replaceSessionEntry(scope, next);
          const replacementEntry = loadExactSessionEntry(scope)?.entry;
          if (!replacementEntry) {
            throw new Error("Expected the replacement lifecycle");
          }
          if (expectedControlBinding) {
            expectedControlBinding.ownerKey = "agent:main:new-owner";
          }
          const replacementMeta = { ...META, runtimeSessionName: "replacement-runtime" };
          writeAcpSessionMetaForMigration({
            env: state.env,
            sessionKey: buildAcpDatabaseSessionKey(scope.sessionKey, scope.agentId),
            sessionId: replacementEntry.sessionId,
            lifecycleRevision: replacementEntry.lifecycleRevision,
            meta: replacementMeta,
          });
          release.resolve();
          const settled = await outcome;
          expect(settled.ok).toBe(false);
          if (!settled.ok) {
            expect(String(settled.error)).toMatch(/Canonical ACP session changed before/);
          }
          expect(mutate).toHaveBeenCalledOnce();
          expect(loadExactSessionEntry(scope)?.entry).toEqual(replacementEntry);
          expect(readAcpSessionMeta(scope)).toEqual(replacementMeta);
        } finally {
          release.resolve();
          await outcome;
          intercepted.mockRestore();
        }
      },
    );
  },
);

it("preserves concurrent metadata changes within the original lifecycle", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "acp-write-same-lifecycle" },
    async (state) => {
      const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
      await state.writeConfig(cfg);
      const scope = {
        cfg,
        env: state.env,
        agentId: "main",
        sessionKey: "agent:main:acp:metadata-race",
        skipMaintenance: true,
      };
      await upsertAcpSessionMeta({ ...scope, mutate: () => META });
      const entry = loadExactSessionEntry(scope)?.entry;
      if (!entry) {
        throw new Error("Expected the initialized lifecycle");
      }
      const reached = createDeferredCore();
      const release = createDeferredCore();
      const original = entryWorker.updateAcpSessionStoreEntry;
      let paused = false;
      const intercepted = vi
        .spyOn(entryWorker, "updateAcpSessionStoreEntry")
        .mockImplementation(async (input) => {
          if (!paused && input.mutation.kind === "touch") {
            paused = true;
            reached.resolve();
            await release.promise;
          }
          return original(input);
        });
      const updatedMeta = { ...META, runtimeSessionName: "same-lifecycle-update" };
      const updating = upsertAcpSessionMeta({ ...scope, mutate: () => updatedMeta });
      const outcome = updating.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await Promise.race([
          reached.promise,
          outcome.then(() => {
            throw new Error("ACP update settled before entry mutation");
          }),
        ]);
        await replaceSessionEntry(scope, {
          ...entry,
          label: "concurrent-label",
          updatedAt: entry.updatedAt + 1,
        });
        release.resolve();
        expect((await outcome).ok).toBe(true);
        expect(loadExactSessionEntry(scope)?.entry).toMatchObject({
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          label: "concurrent-label",
        });
        expect(readAcpSessionMeta(scope)).toEqual(updatedMeta);
      } finally {
        release.resolve();
        await outcome;
        intercepted.mockRestore();
      }
    },
  );
});

it("does not close a lifecycle that appears after an absent-entry close was prepared", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "acp-close-absent-race" },
    async (state) => {
      const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
      await state.writeConfig(cfg);
      openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const scope = {
        cfg,
        env: state.env,
        agentId: "main",
        sessionKey: "agent:main:acp:appeared",
        skipMaintenance: true,
      };
      const reached = createDeferredCore();
      const release = createDeferredCore();
      const original = stateWorker.runOpenClawStateWorkerOperation;
      const intercepted = vi
        .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
        .mockImplementation((context, operation, options) =>
          original(
            context,
            (worker) =>
              operation({
                ...worker,
                execute: new Proxy(worker.execute, {
                  apply(execute, receiver, args: Parameters<typeof worker.execute>) {
                    if (args[0].type === "acp.commitMutation") {
                      reached.resolve();
                      return release.promise.then(() => Reflect.apply(execute, receiver, args));
                    }
                    return Reflect.apply(execute, receiver, args);
                  },
                }),
              }),
            options,
          ),
        );
      const mutate = vi.fn(() => null);
      const closing = upsertAcpSessionMeta({ ...scope, mutate });
      const outcome = closing.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await Promise.race([
          reached.promise,
          outcome.then(() => {
            throw new Error("ACP close settled before shared publication");
          }),
        ]);
        await replaceSessionEntry(scope, {
          sessionId: "appeared-session",
          lifecycleRevision: "appeared-revision",
          updatedAt: 200,
        });
        const appeared = loadExactSessionEntry(scope)?.entry;
        if (!appeared) {
          throw new Error("Expected the new canonical lifecycle");
        }
        writeAcpSessionMetaForMigration({
          env: state.env,
          sessionKey: buildAcpDatabaseSessionKey(scope.sessionKey, scope.agentId),
          sessionId: appeared.sessionId,
          lifecycleRevision: appeared.lifecycleRevision,
          meta: META,
        });
        release.resolve();
        const settled = await outcome;
        expect(settled.ok).toBe(false);
        if (!settled.ok) {
          expect(String(settled.error)).toMatch(/Canonical ACP session changed before/);
        }
        expect(mutate).toHaveBeenCalledOnce();
        expect(loadExactSessionEntry(scope)?.entry).toEqual(appeared);
        expect(readAcpSessionMeta(scope)).toEqual(META);
      } finally {
        release.resolve();
        await outcome;
        intercepted.mockRestore();
      }
    },
  );
});

it("does not replay a callback or mutate either store after callback authority is revoked", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "acp-write-revoked" },
    async (state) => {
      const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
      await state.writeConfig(cfg);
      const scope = {
        cfg,
        env: state.env,
        agentId: "main",
        sessionKey: "agent:main:acp:revoked",
        skipMaintenance: true,
      };
      await upsertAcpSessionMeta({ ...scope, mutate: () => META });
      const before = loadExactSessionEntry(scope)?.entry;
      let current = true;
      const mutate = vi.fn(() => {
        current = false;
        return null;
      });
      await expect(
        upsertAcpSessionMeta({
          ...scope,
          assertCommitAllowed: () => {
            if (!current) {
              throw new Error("revoked ACP actor");
            }
          },
          mutate,
        }),
      ).rejects.toThrow("revoked ACP actor");
      expect(mutate).toHaveBeenCalledOnce();
      expect(loadExactSessionEntry(scope)?.entry).toEqual(before);
      expect(readAcpSessionMeta(scope)).toEqual(META);
    },
  );
});
