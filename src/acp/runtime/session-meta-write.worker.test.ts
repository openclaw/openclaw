import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readLegacyAcpMigrationContext } from "../../config/sessions/session-accessor.sqlite-acp-provenance.js";
import { retainPreparedSessionSharingFacts } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { projectSessionSharingEntry } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import * as entryPublication from "../../config/sessions/session-accessor.sqlite-entry-worker-publication.js";
import * as historyMaintenance from "../../config/sessions/session-history-eviction.js";
import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as admissions from "../../infra/sqlite-worker-operation-admission.js";
import {
  sessionChanges,
  type SessionRowChange,
  type SessionRowFacts,
} from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as entryWorker from "./session-meta-entry.js";
import { buildAcpDatabaseSessionKey } from "./session-meta-keys.js";
import { readAcpSessionEntryAsync } from "./session-meta-read.js";
import { readAcpSessionMetaForEntries } from "./session-meta-readonly.js";
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

type Scope = {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentId: string;
  sessionKey: string;
  skipMaintenance: boolean;
};

function withSession(
  label: string,
  run: (state: OpenClawTestState, scope: Scope) => Promise<void>,
) {
  return withOpenClawTestState({ scenario: "minimal", label }, async (state) => {
    const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
    await state.writeConfig(cfg);
    await run(state, {
      cfg,
      env: state.env,
      agentId: "main",
      sessionKey: `agent:main:acp:${label}`,
      skipMaintenance: true,
    });
  });
}

function isAcpChange(
  change: SessionRowChange,
  scope: Scope,
): change is Extract<SessionRowChange, { sessionKey: string }> {
  return "sessionKey" in change && change.sessionKey === scope.sessionKey && change.scope === "acp";
}

function requireEntry(scope: Scope) {
  const entry = loadExactSessionEntry(scope)?.entry;
  assert(entry, "Expected a canonical ACP lifecycle");
  return entry;
}

function writeNative(scope: Scope, entry: SessionEntry, meta: SessionAcpMeta) {
  writeAcpSessionMetaForMigration({
    env: scope.env,
    sessionKey: buildAcpDatabaseSessionKey(scope.sessionKey, scope.agentId),
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
    meta,
  });
}

function settle<T>(work: Promise<T>) {
  return work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

it("does not publish a delayed ACP postimage over a newer native publication", async () => {
  await withSession("native-order", async (_state, scope) => {
    const entry = await upsertAcpSessionMeta({ ...scope, mutate: () => META });
    expect(entry).toBeDefined();
    const native = { ...META, runtimeSessionName: "newer-native" };
    const changes: Array<SessionRowFacts | undefined> = [];
    const release = sessionChanges.subscribeFacts((change) => {
      if (isAcpChange(change, scope)) {
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
            isRecord(facts) &&
            isRecord(facts.facts) &&
            facts.facts.kind === "acp"
          ) {
            superseded = true;
            writeNative(scope, entry!, native);
          }
          consume(receipt);
        });
      });
    using _ = {
      [Symbol.dispose]() {
        release();
        intercept.mockRestore();
      },
    };
    await upsertAcpSessionMeta({
      ...scope,
      mutate: () => ({ ...META, runtimeSessionName: "older-worker" }),
    });
    expect(superseded).toBe(true);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((change) => change === undefined)).toBe(true);
    expect(readAcpSessionEntry(scope)?.acp).toEqual(native);
  });
});

it.each(["incognito", "file"] as const)(
  "creates, updates, and closes %s metadata through its storage owner",
  async (storage) => {
    await withSession(`acp-write-${storage}`, async (state, scope) => {
      await state.writeConfig({
        ...scope.cfg,
        session: { maintenance: { mode: "warn", maxEntries: 37 } },
      });
      const incognito = storage === "incognito";
      scope.sessionKey = incognito
        ? "agent:main:dashboard:incognito-private"
        : "agent:main:acp:worker";
      const paths = [
        resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
        resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
      ].flatMap((database) => [database, `${database}-wal`, `${database}-shm`]);
      paths.push(path.join(state.sessionsDir("main"), "sessions.json"));
      if (incognito) {
        expect(paths.filter((filename) => fs.existsSync(filename))).toEqual([]);
      }
      const observe = observeHostDataSql();
      const expectMetadata = async (entry: SessionEntry, meta: SessionAcpMeta | null) => {
        if (incognito) {
          expect((await readAcpSessionEntryAsync(scope))?.acp).toEqual(meta);
        } else {
          expect(
            await readAcpSessionMetaForEntries({
              env: state.env,
              entries: [{ sessionKey: scope.sessionKey, agentId: scope.agentId, entry }],
            }),
          ).toEqual([meta]);
        }
      };
      let latestAcp: Extract<SessionRowFacts, { kind: "acp" }> | undefined;
      const observedAcp: Array<Extract<SessionRowFacts, { kind: "acp" }>> = [];
      const releaseFacts = sessionChanges.subscribeFacts((change) => {
        if (isAcpChange(change, scope)) {
          latestAcp = change.facts?.kind === "acp" ? change.facts : undefined;
        }
      });
      const releaseObservers = sessionChanges.subscribe((change) => {
        if (isAcpChange(change, scope) && latestAcp) {
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
        assert(created, "Expected the initialized ACP session");
        await expectMetadata(created, META);
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
          await expectMetadata(created, updatedMeta);
          if (!incognito) {
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
        if (!incognito) {
          expect(maintenance.mock.calls.length).toBeGreaterThan(0);
          expect(
            maintenance.mock.calls.every(([input]) => input.maintenanceConfig?.maxEntries === 37),
          ).toBe(true);
        }
        maintenance.mockClear();
        const cleared = await upsertAcpSessionMeta({ ...scope, mutate: () => null });
        expect(cleared?.acp).toBeUndefined();
        expect(observedAcp.at(-1)?.acp).toBeNull();
        if (!incognito) {
          await expectMetadata(created, null);
        }
        expect(maintenance).not.toHaveBeenCalled();
        expect(observe.queries).toEqual([]);
      } finally {
        releaseFacts();
        releaseObservers();
        observe.restore();
        maintenance.mockRestore();
      }
      const result = await readAcpSessionEntryAsync(scope);
      expect(result?.acp).toBeUndefined();
      const persisted = result?.entry;
      expect(persisted?.sessionId).toBeTruthy();
      expect(persisted?.acp).toBeUndefined();
      if (incognito) {
        expect(paths.filter((filename) => fs.existsSync(filename))).toEqual([]);
      } else {
        expect(
          openOpenClawStateDatabase({ env: state.env })
            .db.prepare("SELECT count(*) AS count FROM acp_sessions")
            .get(),
        ).toEqual({ count: 0 });
        const invalid = { ...scope, sessionKey: `${scope.sessionKey}-uncloneable` };
        await expect(
          upsertAcpSessionMeta({
            ...invalid,
            mutate: () => ({ ...META, uncloneable: () => undefined }),
          }),
        ).rejects.toMatchObject({ name: "DataCloneError" });
        expect(loadExactSessionEntry(invalid)?.entry).toBeUndefined();
      }
    });
  },
);

const replacementFields = {
  "same-lifecycle": {},
  "session-id": { sessionId: "replacement-session" },
  "lifecycle-revision": { lifecycleRevision: "replacement-revision" },
  "control-owner": { spawnedBy: "agent:main:new-owner" },
  "absent-entry": {
    sessionId: "appeared-session",
    lifecycleRevision: "appeared-revision",
    updatedAt: 200,
  },
};

it.each([
  ["before-touch", "same-lifecycle"],
  ["before-touch", "session-id"],
  ["before-touch", "lifecycle-revision"],
  ["before-touch", "control-owner"],
  ["after-touch", "session-id"],
  ["after-touch", "lifecycle-revision"],
  ["after-touch", "control-owner"],
  ["before-commit", "absent-entry"],
] as const)(
  "fences a %s concurrent %s change at the original ACP lifecycle",
  async (boundary, replacement) => {
    await withSession(`acp-write-${boundary}-${replacement}`, async (state, scope) => {
      setRuntimeConfigSnapshot(scope.cfg);
      const absent = replacement === "absent-entry";
      if (absent) {
        openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      } else {
        await replaceSessionEntry(scope, {
          sessionId: "initial-session",
          lifecycleRevision: "initial-revision",
          spawnedBy: "agent:main:owner",
          updatedAt: 100,
        });
        await upsertAcpSessionMeta({ ...scope, mutate: () => META });
        expect(readLegacyAcpMigrationContext(scope).sources).toEqual([]);
      }
      const originalEntry = absent ? undefined : requireEntry(scope);
      const reached = createDeferredCore();
      const release = createDeferredCore();
      const original = entryWorker.updateAcpSessionStoreEntry;
      const runWorker = stateWorker.runOpenClawStateWorkerOperation;
      let paused = false;
      const intercepted = absent
        ? vi
            .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
            .mockImplementation((context, operation, options) =>
              runWorker(
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
            )
        : vi.spyOn(entryWorker, "updateAcpSessionStoreEntry").mockImplementation(async (input) => {
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
      const mutate = vi.fn(() => (absent ? null : updatedMeta));
      const expectedControlBinding =
        replacement === "control-owner" && originalEntry
          ? {
              sessionId: originalEntry.sessionId,
              lifecycleRevision: originalEntry.lifecycleRevision,
              sessionStartedAt: originalEntry.sessionStartedAt,
              ownerKey: "agent:main:owner",
            }
          : undefined;
      const outcome = settle(upsertAcpSessionMeta({ ...scope, mutate, expectedControlBinding }));
      try {
        await awaitGateBeforeSettlement(
          reached.promise,
          outcome,
          "ACP mutation settled before the requested boundary",
        );
        const next = originalEntry
          ? {
              ...originalEntry,
              updatedAt: originalEntry.updatedAt + 1,
              label: "concurrent-label",
              ...replacementFields[replacement],
            }
          : replacementFields["absent-entry"];
        await replaceSessionEntry(scope, next);
        const replacementEntry = requireEntry(scope);
        if (expectedControlBinding) {
          expectedControlBinding.ownerKey = "agent:main:new-owner";
        }
        const replacementMeta = absent
          ? META
          : { ...META, runtimeSessionName: "replacement-runtime" };
        if (replacement !== "same-lifecycle") {
          writeNative(scope, replacementEntry, replacementMeta);
        }
        release.resolve();
        const settled = await outcome;
        expect(settled.ok).toBe(replacement === "same-lifecycle");
        if (!settled.ok) {
          expect(String(settled.error)).toMatch(/Canonical ACP session changed before/);
        }
        expect(mutate).toHaveBeenCalledOnce();
        if (replacement === "same-lifecycle" && originalEntry) {
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
    });
  },
);
