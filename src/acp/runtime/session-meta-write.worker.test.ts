import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { renderAssistantRequestFailureCopy } from "../../agents/failover/assistant-request-failure-copy.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readLegacyAcpMigrationContext } from "../../config/sessions/session-accessor.sqlite-acp-provenance.js";
import { retainPreparedSessionSharingFacts } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { projectSessionSharingEntry } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import * as entryPublication from "../../config/sessions/session-accessor.sqlite-entry-worker-publication.js";
import * as sessionEntryWorker from "../../config/sessions/session-accessor.sqlite-replacement-worker.js";
import * as historyMaintenance from "../../config/sessions/session-history-eviction.js";
import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessageWithCode } from "../../infra/errors.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
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
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as entryWorker from "./session-meta-entry.js";
import { seedCanonicalAcpSessionMeta } from "./session-meta-fixture.test-support.js";
import { createAcpMeta, interceptAcpCommit } from "./session-meta-lifecycle.test-support.js";
import { readAcpSessionEntryAsync } from "./session-meta-read.js";
import { readAcpSessionMetaForEntries } from "./session-meta-readonly.js";
import { upsertAcpSessionMeta } from "./session-meta-write.js";
import { listAcpSessionEntries, readAcpSessionEntry } from "./session-meta.js";

const META = createAcpMeta({ agent: "fixture-agent" });

type Mutation = Parameters<typeof upsertAcpSessionMeta>[0];
type Scope = Required<Pick<Mutation, "cfg" | "env" | "agentId" | "sessionKey" | "skipMaintenance">>;

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

it("retains storage guidance when ACP entry rollback loses native settlement", () =>
  withSession("unknown-storage", async (_state, scope) => {
    await upsertAcpSessionMeta({ ...scope, mutate: () => META });
    const initial = await readAcpSessionEntryAsync(scope);
    const storageError = Object.assign(new Error("database or disk is full"), {
      code: "SQLITE_FULL",
    });
    const settlementError = new Error("Native ACP settlement was lost");
    const original = sessionEntryWorker.withSessionEntryWorker;
    const restoreSettlement: Array<() => void> = [];
    const intercepted = vi
      .spyOn(sessionEntryWorker, "withSessionEntryWorker")
      .mockImplementation((...args) => {
        const [options, identity, assertCurrent, run, onCommit, ...rest] = args;
        return original(
          options,
          identity,
          assertCurrent,
          run,
          (admission, retained, facts) => {
            // Lose only settlement evidence; the native writer still rolls back the refused commit.
            const settlement = vi
              .spyOn(admission, "settlement", "get")
              .mockReturnValue({ kind: "unknown" });
            restoreSettlement.push(() => settlement.mockRestore());
            onCommit?.(
              admission,
              {
                settled: retained.settled.then(() => ({
                  kind: "unknown" as const,
                  error: settlementError,
                })),
              },
              facts,
            );
            throw storageError;
          },
          ...rest,
        );
      });
    try {
      await expect(
        upsertAcpSessionMeta({ ...scope, mutate: () => ({ ...META, lastActivityAt: 200 }) }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(formatErrorMessageWithCode(error)).toContain(storageError.message);
        expect(formatErrorMessageWithCode(error)).toContain(settlementError.message);
        expect(
          renderAssistantRequestFailureCopy({
            storageFailure: classifyGatewayStorageFailure(error),
          }),
        ).toContain("disk is full. Free up space");
        return true;
      });
    } finally {
      intercepted.mockRestore();
      for (const restore of restoreSettlement) {
        restore();
      }
    }
    expect((await readAcpSessionEntryAsync(scope))?.entry).toEqual(initial?.entry);
  }));

it("does not publish a delayed ACP postimage over a newer native publication", () =>
  withSession("native-order", async (_state, scope) => {
    const entry = await upsertAcpSessionMeta({ ...scope, mutate: () => META });
    expect(entry).toBeDefined();
    const native = { ...META, runtimeSessionName: "newer-native" };
    const changes: Array<SessionRowFacts | undefined> = [];
    using cleanup = new DisposableStack();
    const release = sessionChanges.subscribeFacts((change) => {
      if (isAcpChange(change, scope)) {
        changes.push(change.facts);
      }
    });
    cleanup.defer(release);
    const observe = admissions.observeSqliteWorkerCommittedFacts;
    let superseded = false;
    const interception = vi
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
            seedCanonicalAcpSessionMeta({ ...entry, ...scope, meta: native });
          }
          consume(receipt);
        });
      });
    cleanup.use(interception);
    await upsertAcpSessionMeta({
      ...scope,
      mutate: () => ({ ...META, runtimeSessionName: "older-worker" }),
    });
    expect(superseded).toBe(true);
    expect(new Set(changes)).toEqual(new Set([undefined]));
    expect(readAcpSessionEntry(scope)?.acp).toEqual(native);
  }));

it.each(["incognito", "file"] as const)(
  "creates, updates, and closes %s metadata through its storage owner",
  (storage) =>
    withSession(`acp-write-${storage}`, async (state, scope) => {
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
      const initialMeta = { ...META, cwd: "/repo" };
      const initialize = vi.fn(() => initialMeta);
      const updatedMeta = { ...initialMeta, state: "running" as const, lastActivityAt: 200 };
      const update = vi.fn((current: SessionAcpMeta | undefined) => {
        expect(current).toEqual(initialMeta);
        return updatedMeta;
      });
      try {
        const created = await upsertAcpSessionMeta({
          ...scope,
          now: () => 200,
          mutate: initialize,
        });
        expect(created?.acp).toEqual(initialMeta);
        expect(observedAcp.at(-1)).toMatchObject({
          kind: "acp",
          sessionId: created?.sessionId,
          lifecycleRevision: created?.lifecycleRevision ?? null,
          acp: initialMeta,
        });
        assert(created, "Expected the initialized ACP session");
        await expectMetadata(created, initialMeta);
        if (!incognito) {
          const stored = (await readAcpSessionEntryAsync(scope))?.entry;
          expect(stored).toMatchObject({
            sessionId: expect.any(String),
            lifecycleRevision: expect.any(String),
            updatedAt: expect.any(Number),
          });
          expect(created.sessionId).toEqual(expect.any(String));
          expect(stored?.sessionStartedAt).toBeGreaterThan(200);
          expect(stored?.acp).toBeUndefined();
          expect(fs.existsSync(paths.at(-1)!)).toBe(false);
          expect(await listAcpSessionEntries(scope)).toHaveLength(1);
        }
        const retainedMembership: boolean[] = [];
        using releases = new DisposableStack();
        const retainPublication = entryPublication.retainSessionEntryWorkerPublication;
        using publication = vi
          .spyOn(entryPublication, "retainSessionEntryWorkerPublication")
          .mockImplementation((input) => {
            const retained = retainPreparedSessionSharingFacts({
              databaseIdentity: `file:${input.databaseIdentity}`,
              sessionKey: scope.sessionKey,
              entry: projectSessionSharingEntry(created),
              membership: new Set(["existing-reader"]),
            });
            releases.defer(retained.release);
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
        const updated = await upsertAcpSessionMeta({ ...scope, mutate: update });
        expect(updated?.acp).toEqual(updatedMeta);
        expect(observedAcp.at(-1)?.acp).toEqual(updatedMeta);
        await expectMetadata(created, updatedMeta);
        if (!incognito) {
          expect(new Set(retainedMembership)).toEqual(new Set([true]));
        }
        publication.mockRestore();
        releases.dispose();
        expect(initialize).toHaveBeenCalledOnce();
        expect(update).toHaveBeenCalledOnce();
        if (!incognito) {
          expect(
            new Set(maintenance.mock.calls.map(([input]) => input.maintenanceConfig?.maxEntries)),
          ).toEqual(new Set([37]));
        }
        maintenance.mockClear();
        const cleared = await upsertAcpSessionMeta({ ...scope, mutate: () => null });
        expect([cleared?.acp, observedAcp.at(-1)?.acp]).toEqual([undefined, null]);
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
      expect([result?.acp, result?.entry?.acp]).toEqual([undefined, undefined]);
      expect(result?.entry?.sessionId).toBeTruthy();
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
    }),
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
  (boundary, replacement) =>
    withSession(`acp-write-${boundary}-${replacement}`, async (state, scope) => {
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
      const intercepted = absent
        ? interceptAcpCommit(async (execute) => {
            reached.resolve();
            await release.promise;
            return execute();
          })
        : vi
            .spyOn(entryWorker, "updateAcpSessionStoreEntry")
            .mockImplementationOnce(async (input) => {
              expect(input.mutation.kind).toBe("touch");
              if (boundary === "before-touch") {
                reached.resolve();
                await release.promise;
              }
              const result = await original(input);
              if (boundary === "after-touch") {
                reached.resolve();
                await release.promise;
              }
              return result;
            });
      const updatedMeta = { ...META, runtimeSessionName: "same-lifecycle-update" };
      const mutate = vi.fn(() => (absent ? null : updatedMeta));
      const expectedControlBinding =
        replacement === "control-owner" && originalEntry
          ? { ...originalEntry, ownerKey: "agent:main:owner" }
          : undefined;
      const outcome = upsertAcpSessionMeta({ ...scope, mutate, expectedControlBinding }).then(
        () => null,
        String,
      );
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
          seedCanonicalAcpSessionMeta({ ...replacementEntry, ...scope, meta: replacementMeta });
        }
        release.resolve();
        expect(await outcome).toEqual(
          replacement === "same-lifecycle"
            ? null
            : expect.stringMatching(/Canonical ACP session changed before/),
        );
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
    }),
);
