import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readLegacyAcpMigrationContext } from "../../config/sessions/session-accessor.sqlite-acp-provenance.js";
import { retainPreparedSessionSharingFacts } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import * as entryPublication from "../../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import { projectSessionSharingEntry } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import * as historyMaintenance from "../../config/sessions/session-history-eviction.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as admissions from "../../infra/sqlite-worker-operation-admission.js";
import { sessionChanges, type SessionRowFacts } from "../../sessions/session-row-changes.js";
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
import { readAcpSessionEntry, writeAcpSessionMetaForMigration } from "./session-meta.js";

const META: SessionAcpMeta = {
  backend: "fixture-backend",
  agent: "fixture-agent",
  runtimeSessionName: "worker-session",
  mode: "persistent",
  state: "idle",
  lastActivityAt: 100,
};

it("does not publish a delayed ACP postimage over a newer native publication", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", label: "acp-receipt-native-order" },
    async (state) => {
      const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
      await state.writeConfig(cfg);
      const scope = {
        cfg,
        env: state.env,
        agentId: "main",
        sessionKey: "agent:main:acp:native-order",
        skipMaintenance: true,
      };
      const entry = await upsertAcpSessionMeta({ ...scope, mutate: () => META });
      expect(entry).toBeDefined();
      const native = { ...META, runtimeSessionName: "newer-native" };
      const changes: Array<SessionRowFacts | undefined> = [];
      const release = sessionChanges.subscribeFacts((change) => {
        if (
          "sessionKey" in change &&
          change.sessionKey === scope.sessionKey &&
          change.scope === "acp"
        ) {
          changes.push(change.facts);
        }
      });
      const observe = admissions.observeSqliteWorkerCommittedFacts;
      let superseded = false;
      const intercept = vi
        .spyOn(admissions, "observeSqliteWorkerCommittedFacts")
        .mockImplementation((admission, consume) => {
          observe(admission, (receipt) => {
            const facts = receipt.facts;
            if (
              !superseded &&
              facts &&
              typeof facts === "object" &&
              "facts" in facts &&
              facts.facts &&
              typeof facts.facts === "object" &&
              "kind" in facts.facts &&
              facts.facts.kind === "acp"
            ) {
              superseded = true;
              writeAcpSessionMetaForMigration({
                env: state.env,
                sessionKey: buildAcpDatabaseSessionKey(scope.sessionKey, scope.agentId),
                sessionId: entry!.sessionId,
                lifecycleRevision: entry!.lifecycleRevision,
                meta: native,
              });
            }
            consume(receipt);
          });
        });
      try {
        await upsertAcpSessionMeta({
          ...scope,
          mutate: () => ({ ...META, runtimeSessionName: "older-worker" }),
        });
        expect(superseded).toBe(true);
        expect(changes.length).toBeGreaterThan(0);
        expect(changes.every((change) => change === undefined)).toBe(true);
        expect(readAcpSessionEntry(scope)?.acp).toEqual(native);
      } finally {
        release();
        intercept.mockRestore();
      }
    },
  );
});

it.each(["incognito", "file"] as const)(
  "creates, updates, and closes %s metadata through its storage owner",
  async (storage) => {
    await withOpenClawTestState(
      { scenario: "minimal", label: `acp-write-${storage}` },
      async (state) => {
        const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
        await state.writeConfig({
          ...cfg,
          session: { maintenance: { mode: "warn", maxEntries: 37 } },
        });
        const incognito = storage === "incognito";
        const scope = {
          cfg,
          env: state.env,
          agentId: "main",
          skipMaintenance: true,
          sessionKey: incognito
            ? "agent:main:dashboard:incognito-private"
            : "agent:main:acp:worker",
        };
        if (incognito) {
          await replaceSessionEntry(scope, {
            sessionId: "private-session",
            lifecycleRevision: "private-revision",
            updatedAt: 100,
            label: "private-session-label",
            skillsSnapshot: { prompt: "private-session-prompt", skills: [] },
          });
        }
        const initial = incognito ? loadExactSessionEntry(scope)?.entry : undefined;
        const paths = [
          resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
          resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
        ].flatMap((database) => [database, `${database}-wal`, `${database}-shm`]);
        paths.push(path.join(state.sessionsDir("main"), "sessions.json"));
        if (incognito) {
          expect(initial).toBeDefined();
          expect(paths.filter((filename) => fs.existsSync(filename))).toEqual([]);
        }
        const observe = observeHostDataSql();
        let latestAcp: Extract<SessionRowFacts, { kind: "acp" }> | undefined;
        const observedAcp: Array<Extract<SessionRowFacts, { kind: "acp" }>> = [];
        const releaseFacts = sessionChanges.subscribeFacts((change) => {
          if (
            "sessionKey" in change &&
            change.sessionKey === scope.sessionKey &&
            change.scope === "acp"
          ) {
            latestAcp = change.facts?.kind === "acp" ? change.facts : undefined;
          }
        });
        const releaseObservers = sessionChanges.subscribe((change) => {
          if (
            "sessionKey" in change &&
            change.sessionKey === scope.sessionKey &&
            change.scope === "acp" &&
            latestAcp
          ) {
            observedAcp.push(latestAcp);
          }
        });
        const maintenance = vi.spyOn(historyMaintenance, "kickSessionHistoryDiskBudgetMaintenance");
        const initialize = vi.fn(() => META);
        const updatedMeta = { ...META, state: "running" as const, lastActivityAt: 200 };
        const update = vi.fn((current: SessionAcpMeta | undefined) => {
          expect(current).toEqual(META);
          return updatedMeta;
        });
        try {
          const created = await upsertAcpSessionMeta({ ...scope, mutate: initialize });
          expect(created?.acp).toEqual(META);
          expect(observedAcp.at(-1)).toMatchObject({
            kind: "acp",
            sessionId: created?.sessionId,
            lifecycleRevision: created?.lifecycleRevision ?? null,
            acp: META,
          });
          if (!created) {
            throw new Error("Expected the initialized ACP session");
          }
          if (incognito) {
            expect(readAcpSessionEntry(scope)?.acp).toEqual(META);
          }
          const retainedMembership: boolean[] = [];
          const releases: Array<() => void> = [];
          const retainPublication = entryPublication.retainSessionEntryWorkerPublication;
          const publication = vi
            .spyOn(entryPublication, "retainSessionEntryWorkerPublication")
            .mockImplementation((input) => {
              const retained = retainPreparedSessionSharingFacts({
                databaseIdentity: `file:${input.databaseIdentity}`,
                sessionKey: scope.sessionKey,
                entry: projectSessionSharingEntry(created),
                membership: new Set(["existing-reader"]),
              });
              releases.push(retained.release);
              const owner = retainPublication(input);
              return {
                ...owner,
                begin(...args) {
                  owner.begin(...args);
                  retainedMembership.push(
                    retained.readCurrent()?.membership.has("existing-reader") === true,
                  );
                },
              };
            });
          try {
            const updated = await upsertAcpSessionMeta({ ...scope, mutate: update });
            expect(updated?.acp).toEqual(updatedMeta);
            expect(observedAcp.at(-1)?.acp).toEqual(updatedMeta);
            if (incognito) {
              expect(readAcpSessionEntry(scope)?.acp).toEqual(updatedMeta);
            } else {
              expect(retainedMembership.length).toBeGreaterThan(0);
              expect(retainedMembership.every(Boolean)).toBe(true);
            }
          } finally {
            publication.mockRestore();
            for (const release of releases) {
              release();
            }
          }
          expect(initialize).toHaveBeenCalledOnce();
          expect(update).toHaveBeenCalledOnce();
          expect(update.mock.calls[0]?.[0]).toEqual(META);
          const cleared = await upsertAcpSessionMeta({ ...scope, mutate: () => null });
          expect(cleared?.acp).toBeUndefined();
          expect(observedAcp.at(-1)?.acp).toBeNull();
          if (!incognito) {
            expect(observe.queries).toEqual([]);
            expect(maintenance.mock.calls.length).toBeGreaterThan(0);
            expect(
              maintenance.mock.calls.every(([input]) => input.maintenanceConfig?.maxEntries === 37),
            ).toBe(true);
          }
        } finally {
          releaseFacts();
          releaseObservers();
          observe.restore();
          maintenance.mockRestore();
        }
        expect(readAcpSessionEntry(scope)?.acp).toBeUndefined();
        const persisted = loadExactSessionEntry(scope)?.entry;
        expect(persisted?.sessionId).toBeTruthy();
        expect(persisted?.acp).toBeUndefined();
        if (incognito) {
          expect(persisted).toMatchObject({
            sessionId: initial?.sessionId,
            lifecycleRevision: initial?.lifecycleRevision,
            label: initial?.label,
            skillsSnapshot: initial?.skillsSnapshot,
          });
          expect(paths.filter((filename) => fs.existsSync(filename))).toEqual([]);
        } else {
          expect(
            openOpenClawStateDatabase({ env: state.env })
              .db.prepare("SELECT count(*) AS count FROM acp_sessions")
              .get(),
          ).toEqual({ count: 0 });
        }
      },
    );
  },
);

it.each([
  ["before-touch", "same-lifecycle"],
  ["before-touch", "session-id"],
  ["before-touch", "lifecycle-revision"],
  ["before-touch", "control-owner"],
  ["after-touch", "session-id"],
  ["after-touch", "lifecycle-revision"],
  ["after-touch", "control-owner"],
] as const)(
  "fences a %s concurrent %s change at the original ACP lifecycle",
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
            if (!paused && boundary === "after-touch" && input.mutation.kind === "touch") {
              paused = true;
              reached.resolve();
              await release.promise;
            }
            return result;
          });
        const updatedMeta = { ...META, runtimeSessionName: "same-lifecycle-update" };
        const mutate = vi.fn(() => updatedMeta);
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
            updatedAt: originalEntry.updatedAt + 1,
            label: "concurrent-label",
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
          if (replacement !== "same-lifecycle") {
            writeAcpSessionMetaForMigration({
              env: state.env,
              sessionKey: buildAcpDatabaseSessionKey(scope.sessionKey, scope.agentId),
              sessionId: replacementEntry.sessionId,
              lifecycleRevision: replacementEntry.lifecycleRevision,
              meta: replacementMeta,
            });
          }
          release.resolve();
          const settled = await outcome;
          expect(settled.ok).toBe(replacement === "same-lifecycle");
          if (!settled.ok) {
            expect(String(settled.error)).toMatch(/Canonical ACP session changed before/);
          }
          expect(mutate).toHaveBeenCalledOnce();
          if (replacement === "same-lifecycle") {
            expect(loadExactSessionEntry(scope)?.entry).toMatchObject({
              sessionId: originalEntry.sessionId,
              lifecycleRevision: originalEntry.lifecycleRevision,
              label: "concurrent-label",
            });
          } else {
            expect(loadExactSessionEntry(scope)?.entry).toEqual(replacementEntry);
          }
          expect(readAcpSessionEntry(scope)?.acp).toEqual(
            replacement === "same-lifecycle" ? updatedMeta : replacementMeta,
          );
        } finally {
          release.resolve();
          await outcome;
          intercepted.mockRestore();
        }
      },
    );
  },
);

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
        expect(readAcpSessionEntry(scope)?.acp).toEqual(META);
      } finally {
        release.resolve();
        await outcome;
        intercepted.mockRestore();
      }
    },
  );
});
