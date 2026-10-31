import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearCronJobActive, markCronJobActive } from "../cron/active-jobs.js";
import { registerActiveCronTaskRun } from "../cron/service/active-run-cancellation.js";
import type { RetainedWorkerTransactionAdmission } from "../infra/sqlite-worker-operation-settlement.js";
import { isSessionStoreTopologyChange, sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { reconstructAgentDeletionJournal } from "../state/agent-deletion-journal-recovery.js";
import { readAgentDeletionRecoveryHolds } from "../state/agent-deletion-journal-recovery.kernel.js";
import {
  completeAgentDeletionJournalInDatabase,
  deleteAgentDeletionJournalInDatabase,
  handoffAgentDeletionJournalInDatabase,
} from "../state/agent-deletion-journal.js";
import { readAgentDeletionJournalStatusInWorker } from "../state/agent-deletion-journal.read.js";
import { recordAgentProvenance } from "../state/agent-provenance.js";
import { recordAgentProvenanceInDatabase } from "../state/agent-provenance.kernel.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  recordOpenClawStateDatabaseOpenFailure,
  requireOpenClawStateDatabaseIdentity,
} from "../state/openclaw-state-db-cache.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../test-utils/agent-deletion-journal.js";
import { readAgentProvenance } from "../test-utils/agent-provenance.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  captureAgentLifecycleBinding,
  claimCompletedAgentDeletion,
  isAgentDeletionBlocked,
  prepareAgentDeletionBlocked,
  matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
  withAgentDeletion as withAgentDeletionRuntime,
  type AgentLifecycleBinding,
} from "./agent-lifecycle-registry.js";

const tempDirs: string[] = [];
let options: ReturnType<typeof createOptions>;

async function withAgentDeletion<T>(
  run: Parameters<typeof withAgentDeletionRuntime<T>>[1],
  agentId = "main",
): Promise<T> {
  // Lifecycle assertions await the real worker, independent of host startup load.
  // Keep lease expiry and fresh Atomics acknowledgements on real Date/performance clocks.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    return await withAgentDeletionRuntime(
      agentId,
      async (begin) => {
        vi.useRealTimers();
        return await run(begin);
      },
      options,
    );
  } finally {
    vi.useRealTimers();
  }
}

function observeSql(...args: Parameters<typeof observeHostDataSql>) {
  const observation = observeHostDataSql(...args);
  return { ...observation, [Symbol.dispose]: () => observation.restore() };
}

async function withoutHostSql<T>(run: () => T | Promise<T>, failOnSql = false): Promise<T> {
  using observation = observeSql(
    failOnSql
      ? () => {
          throw new Error("Deletion authority must not execute SQL on the parent");
        }
      : undefined,
  );
  const result = await run();
  expect(observation.queries).toEqual([]);
  return result;
}

function withoutHostSqlSync(run: () => void): void {
  using observation = observeSql();
  run();
  expect(observation.queries).toEqual([]);
}

function interceptWorker(
  commandType: () => string | undefined,
  hooks: { before?: () => void; after?: () => void; failure?: string },
) {
  const runWorker = stateWorker.runOpenClawStateWorkerOperation;
  return vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, run, workerOptions) => {
      let selected = false;
      const createAdmission = workerOptions?.createAdmission;
      const interceptedOptions = { ...workerOptions };
      const failure = hooks.failure;
      if (createAdmission && failure) {
        interceptedOptions.createAdmission = (retained: RetainedWorkerTransactionAdmission) => {
          const created = createAdmission(retained);
          if (selected) {
            created.admission.observeRequests((request) => {
              if (request.stage === "commit") {
                throw new Error(failure);
              }
            });
          }
          return created;
        };
      }
      return runWorker(
        context,
        (scope) =>
          run({
            ...scope,
            execute: async (command, executeOptions) => {
              selected = command.type === commandType();
              if (selected) {
                hooks.before?.();
              }
              const result = await scope.execute(command, executeOptions);
              if (command.type === commandType()) {
                hooks.after?.();
              }
              return result;
            },
          }),
        interceptedOptions,
      );
    });
}

function createOptions() {
  const stateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-delete-")),
  );
  tempDirs.push(stateDir);
  const stateOptions = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  openOpenClawStateDatabase(stateOptions);
  return stateOptions;
}

function createEntry(agentId = "main") {
  return {
    agentId,
    agentDir: `/agents/${agentId}`,
    workspaceDir: `/workspaces/${agentId}`,
    sessionsDir: `/sessions/${agentId}`,
  };
}

function activeCronRun(jobId: string, agentId: string, stateIdentityKey: string, runId = jobId) {
  const marker = markCronJobActive(jobId, { agentId, stateIdentityKey });
  const controller = new AbortController();
  const unregister = registerActiveCronTaskRun({ runId, controller, activeJobMarker: marker });
  return {
    signal: controller.signal,
    cleanup: () => {
      unregister?.();
      clearCronJobActive(jobId, marker);
    },
  };
}

const journal = (id = "main") => readAgentDeletionJournal(id, options);
const readProvenance = (id = "main") => readAgentProvenance(id, options);
const blocked = (id = "main") => isAgentDeletionBlocked(id, options);
const setProvenance = (
  nowMs?: number,
  agentId = "main",
  createdVia: "operator" | "template" = "operator",
) => recordAgentProvenance(agentId, { createdVia }, { ...options, nowMs });

beforeEach(() => {
  options = createOptions();
});

afterEach(async () => {
  vi.useRealTimers();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent lifecycle registry", () => {
  it.each(["openclaw", "crestodian"])(
    "rejects deletion authority for system agent %s",
    async (agentId) => {
      const original = beginAgentDeletionJournal(
        { ...createEntry(agentId), operationId: "invalid-system-deletion", deleteFiles: true },
        options,
      );
      const cleanup = vi.fn();
      await expect(
        Promise.resolve().then(() => withAgentDeletionRuntime(agentId, cleanup, options)),
      ).rejects.toThrow(`System agent ${agentId} cannot be deleted`);
      expect(cleanup).not.toHaveBeenCalled();
      expect(journal(agentId)).toEqual(original);
    },
  );

  it("keeps lifecycle authority through rollback but rejects terminal database failure", async () => {
    const config = { agents: { entries: { main: {} } } };
    await setProvenance(1);
    const binding = (await captureAgentLifecycleBinding(() => config, "main", options))!;
    await readAgentDeletionJournalStatusInWorker("main", options);
    const preparedBlocked = prepareAgentDeletionBlocked("main", options);
    expect(preparedBlocked()).toBe(false);
    const rollback = new Error("rollback authority changes");
    expect(() =>
      runOpenClawStateWriteTransaction((database) => {
        recordAgentProvenanceInDatabase(database.db, {
          agentId: "main",
          createdVia: "operator",
          creatorAgentId: null,
          createdAtMs: 2,
        });
        expect(matchesAgentLifecycleBinding(config, binding, options)).toBe(true);
        const provenance = readProvenance();
        expect(provenance?.createdAtMs).toBe(2);
        const currentBinding = { ...binding, provenance: provenance ?? null };
        expect(matchesAgentLifecycleBinding(config, currentBinding, options)).toBe(false);
        beginAgentDeletionJournal(
          { ...createEntry(), operationId: "delete-main", deleteFiles: false },
          options,
        );
        expect(blocked()).toBe(true);
        expect(preparedBlocked()).toBe(true);
        expect(matchesAgentLifecycleBinding(config, binding, options)).toBe(true);
        throw rollback;
      }, options),
    ).toThrow(rollback);
    await readAgentDeletionJournalStatusInWorker("main", options);
    expect(blocked()).toBe(false);
    expect(preparedBlocked()).toBe(false);
    expect(matchesAgentLifecycleBinding(config, binding, options)).toBe(true);
    recordOpenClawStateDatabaseOpenFailure(
      openOpenClawStateDatabase(options).path,
      new Error("synthetic terminal failure"),
    );
    expect(preparedBlocked).toThrow();
  });

  it.each(["commit", "rollback"] as const)(
    "revokes only the captured agent's cron runs after deletion journal %s",
    async (outcome) => {
      const otherOptions = createOptions();
      const identity = requireOpenClawStateDatabaseIdentity(openOpenClawStateDatabase(options)).key;
      const otherIdentity = requireOpenClawStateDatabaseIdentity(
        openOpenClawStateDatabase(otherOptions),
      ).key;
      const cleanups: Array<() => void> = [];
      const admit = (jobId: string, agentId: string, stateIdentityKey: string) => {
        const run = activeCronRun(jobId, agentId, stateIdentityKey, `${jobId}-${cleanups.length}`);
        cleanups.push(run.cleanup);
        return run.signal;
      };
      const target = admit("deleted-agent-run", "main", identity);
      const otherAgent = admit("other-agent-run", "kept", identity);
      const otherState = admit("other-state-run", "main", otherIdentity);
      const retired = admit("replaced-run", "main", identity);
      let successor: AbortSignal | undefined;
      const beforeBegin = interceptWorker(() => "agentDeletion.begin", {
        before: () => {
          expect(target.aborted).toBe(false);
          successor = admit("replaced-run", "main", identity);
        },
        failure: outcome === "rollback" ? "rollback journal admission" : undefined,
      });
      try {
        await withAgentDeletion(async (begin) => {
          if (outcome === "rollback") {
            await expect(begin(createEntry())).rejects.toThrow("rollback journal admission");
          } else {
            await begin(createEntry());
          }
          expect(target.aborted).toBe(outcome === "commit");
          expect([
            otherAgent.aborted,
            otherState.aborted,
            retired.aborted,
            successor?.aborted,
          ]).toEqual([false, false, false, false]);
        });
      } finally {
        beforeBegin.mockRestore();
        for (const cleanup of cleanups.toReversed()) {
          cleanup();
        }
      }
    },
  );

  it("publishes committed deletion facts and revokes cleanup even when replies are lost", async () => {
    const identity = requireOpenClawStateDatabaseIdentity(openOpenClawStateDatabase(options)).key;
    const cron = activeCronRun("lost-delete-reply", "main", identity, "lost-delete-run");
    const changes: unknown[] = [];
    const unsubscribe = sessionChanges.subscribe((change) => {
      if (isSessionStoreTopologyChange(change)) {
        changes.push(change);
      }
    });
    let failCommand: string | undefined = "agentDeletion.begin";
    const lostReply = interceptWorker(() => failCommand, {
      after: () => {
        failCommand = undefined;
        throw new Error("synthetic reply lost after native commit");
      },
    });
    try {
      await withAgentDeletion(async (begin) => {
        await expect(begin(createEntry())).rejects.toThrow("synthetic reply lost");
        expect(cron.signal.aborted).toBe(true);
        expect(changes).toHaveLength(1);
        expect(journal()).toMatchObject({ cleanupCompleted: false });
      });
      await withAgentDeletion(async (begin) => {
        const deletion = await begin(createEntry());
        changes.length = 0;
        failCommand = "agentDeletion.fencePaths";
        const databasePaths = [path.join(options.env.OPENCLAW_STATE_DIR, "owned.sqlite")];
        await expect(deletion.fenceDatabasePaths(databasePaths)).rejects.toThrow(
          "synthetic reply lost",
        );
        expect(deletion.entry.databasePaths).toEqual(databasePaths);
        expect(changes).toHaveLength(1);
        failCommand = "agentDeletion.finish";
        await expect(deletion.finish()).rejects.toThrow("synthetic reply lost");
        expect(deletion.assertCurrentHost).toThrow("no longer owns");
        expect(deletion.assertCurrentFinal).toThrow("no longer owns");
        expect(journal()).toMatchObject({ cleanupCompleted: true });
        expect(changes).toHaveLength(2);
      });
    } finally {
      lostReply.mockRestore();
      unsubscribe();
      cron.cleanup();
    }
  });

  it("does not recreate a missing mandatory deletion journal while reading authority", () => {
    expect(journal()).toBeUndefined();
    const database = openOpenClawStateDatabase(options);
    database.db.exec("DROP TABLE agent_deletion_journal");
    expect(() => journal()).toThrow("Agent deletion journal missing; run openclaw doctor --fix");
    runOpenClawStateWriteTransaction((current) => {
      expect(isAgentDeletionBlocked("main", options, current.db)).toBe(false);
      expect(tableExists(current.db, "agent_deletion_journal")).toBe(false);
    }, options);
    expect(tableExists(database.db, "agent_deletion_journal")).toBe(false);
  });

  it("reads current deletion authority across snapshots but rejects closed scopes and databases", async () => {
    const config = { agents: { entries: { main: {} } } };
    await setProvenance();
    const binding = await captureAgentLifecycleBinding(() => config, "main", options);
    await readAgentDeletionJournalStatusInWorker("main", options);
    await readAgentDeletionJournalStatusInWorker("peer", options);
    const peerBlocked = prepareAgentDeletionBlocked("peer", options);
    let retainedGuard: (() => boolean) | undefined;
    let retainedPreparedGuard: (() => boolean) | undefined;
    const preparedBlocked = prepareAgentDeletionBlocked("main", options);
    await withOpenClawStateDatabaseReadSnapshot(async () => {
      retainedGuard = AsyncLocalStorage.bind(blocked);
      retainedPreparedGuard = AsyncLocalStorage.bind(preparedBlocked);
      expect(blocked()).toBe(false);
      expect(preparedBlocked()).toBe(false);
      await withAgentDeletion(async (begin) => {
        const deletion = await begin(createEntry());
        expect(blocked()).toBe(true);
        expect(preparedBlocked()).toBe(true);
        expect(peerBlocked()).toBe(false);
        expect(await captureAgentLifecycleBinding(() => config, "main", options)).toBeUndefined();
        expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(false);
        await withoutHostSql(() => deletion.assertCurrentAsync(), true);
        await deletion.rollback();
        expect(journal()).toBeUndefined();
        await expect(deletion.assertCurrentAsync()).rejects.toThrow("no longer owns");
        expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(true);
        expect(blocked()).toBe(false);
        expect(preparedBlocked()).toBe(false);
      });
    }, options);
    expect(retainedGuard).toThrow("read scope is closing or closed");
    expect(retainedPreparedGuard).toThrow("read scope is closing or closed");
    await closeStateDatabaseForTest();
    expect(preparedBlocked).toThrow();
    expect(peerBlocked).toThrow();
  });

  it("uses committed journal authority for filesystem effects without host SQL", async () => {
    await withAgentDeletion(async (begin) => {
      const entry = createEntry();
      const deletion = await begin(entry);
      const effectPath = path.join(options.env.OPENCLAW_STATE_DIR, "cleanup-effect");
      const writeEffect = () => {
        deletion.assertCurrentFinal();
        fs.writeFileSync(effectPath, "cleanup accepted");
      };
      const operationId = deletion.entry.operationId;
      const mutate = [
        (database: Parameters<typeof handoffAgentDeletionJournalInDatabase>[0]) =>
          handoffAgentDeletionJournalInDatabase(database, "main", operationId, "replacement"),
        (database: Parameters<typeof completeAgentDeletionJournalInDatabase>[0]) =>
          completeAgentDeletionJournalInDatabase(database, "main", operationId),
        (database: Parameters<typeof deleteAgentDeletionJournalInDatabase>[0]) =>
          deleteAgentDeletionJournalInDatabase(database, "main", operationId, false),
      ];
      for (const mutation of mutate) {
        expect(runOpenClawStateWriteTransaction(mutation, options)).toBe(true);
        withoutHostSqlSync(() => {
          expect(writeEffect).toThrow("no longer owns");
        });
        expect(fs.existsSync(effectPath)).toBe(false);
        beginAgentDeletionJournal({ ...entry, operationId, deleteFiles: true }, options);
      }
      expect(() =>
        runOpenClawStateWriteTransaction((database) => {
          handoffAgentDeletionJournalInDatabase(database, "main", operationId, "rolled-back");
          throw new Error("rollback journal change");
        }, options),
      ).toThrow("rollback journal change");
      withoutHostSqlSync(writeEffect);
      expect(fs.readFileSync(effectPath, "utf8")).toBe("cleanup accepted");
      await deletion.rollback();
    });
  });

  it("rejects a current worker reply when deletion closes before the reply is consumed", async () => {
    await withAgentDeletion(async (begin) => {
      const deletion = await begin(createEntry());
      const execute = stateWorker.runOpenClawStateWorkerOperation;
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const heldRead = vi
        .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
        .mockImplementationOnce(async (...args) => {
          const authority = await execute(...args);
          entered.resolve();
          await resume.promise;
          return authority;
        });
      const checking = deletion.assertCurrentAsync();
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          checking,
          "Deletion guard settled before the real authority read",
        );
        await deletion.rollback();
        resume.resolve();
        await expect(checking).rejects.toThrow("no longer owns");
      } finally {
        resume.resolve();
        await Promise.allSettled([checking]);
        heldRead.mockRestore();
      }
    });
  });

  it("preserves recovery holds through rollback and failed completion, then transfers protection to retained deletion", async () => {
    const held = ["worker", "kept"].map((agentId) => ({
      agentId,
      path: openOpenClawAgentDatabase({ ...options, agentId }).path,
    }));
    closeOpenClawAgentDatabasesForTest();
    const originalBytes = held.map((target) => fs.readFileSync(target.path));
    runOpenClawStateWriteTransaction((database) => {
      database.db.exec("DROP TABLE agent_deletion_journal");
      reconstructAgentDeletionJournal(database, held);
    }, options);
    const readHolds = () => readAgentDeletionRecoveryHolds(openOpenClawStateDatabase(options));
    const target = held[0]!;
    const entry = {
      agentId: target.agentId,
      agentDir: path.dirname(target.path),
      workspaceDir: path.join(options.env.OPENCLAW_STATE_DIR, "workspace-worker"),
      sessionsDir: path.join(options.env.OPENCLAW_STATE_DIR, "agents", target.agentId, "sessions"),
      databasePaths: [target.path],
      deleteFiles: false,
    };
    const settle = (action: "finish" | "rollback") =>
      withAgentDeletion(async (begin) => {
        await (await begin(entry))[action]();
      }, target.agentId);
    await setProvenance(undefined, target.agentId);
    const provenance = readProvenance(target.agentId);
    await settle("rollback");
    expect(journal(target.agentId)).toBeUndefined();
    expect(readHolds()).toEqual(held);
    expect(blocked(target.agentId)).toBe(false);
    const leaseId = claimOpenClawAgentDatabaseLease({ ...target, ...options });
    releaseOpenClawAgentDatabaseLease(leaseId, options, "read-only");
    expect(readHolds()).toEqual(held);

    {
      using _ = interceptWorker(() => "agentDeletion.finish", {
        failure: "completion transaction failed",
      });
      await expect(settle("finish")).rejects.toThrow("completion transaction failed");
    }
    expect(journal(target.agentId)).toMatchObject({ cleanupCompleted: false });
    expect(readHolds()).toEqual(held);
    expect(readProvenance(target.agentId)).toEqual(provenance);

    await withoutHostSql(() => settle("finish"));
    expect(readHolds()).toEqual(held.slice(1));
    expect(journal(target.agentId)).toMatchObject({ cleanupCompleted: true, deleteFiles: false });
    expect(() =>
      openOpenClawAgentDatabase({ ...options, agentId: target.agentId, path: target.path }),
    ).toThrow("deleted");
    expect(held.map((store) => fs.readFileSync(store.path))).toEqual(originalBytes);
  });

  it.each(["present", "absent"] as const)(
    "captures without host SQL and follows committed lifecycle receipts with provenance table %s",
    async (provenanceTable) => {
      if (provenanceTable === "absent") {
        openOpenClawStateDatabase(options).db.exec("DROP TABLE agent_provenance");
        await closeStateDatabaseForTest();
        openOpenClawStateDatabase(options);
      }
      let config: OpenClawConfig = { agents: { entries: { main: {} } } };
      const capture = () =>
        withoutHostSql(async () => {
          const binding = await captureAgentLifecycleBinding(() => config, "MAIN", options);
          expect(binding).toBeDefined();
          expect(await matchesAgentLifecycleBindingAsync(() => config, binding!, options)).toBe(
            true,
          );
          return binding!;
        });
      const assertMatches = (binding: AgentLifecycleBinding, expected: boolean) => {
        const executed: string[] = [];
        using observation = observeSql((sql, database) => {
          if (database === undefined) {
            executed.push(sql);
          }
        });
        expect(matchesAgentLifecycleBinding(config, binding, options)).toBe(expected);
        const authorityReads = executed.filter((sql) =>
          /\bagent_(?:provenance|deletion_journal)\b/i.test(sql),
        );
        expect(authorityReads).toHaveLength(0);
        expect(
          observation.queries.some((sql) => /^\s*(?:begin|commit|rollback|savepoint)\b/i.test(sql)),
        ).toBe(false);
      };
      const legacy = await capture();
      expect(legacy).toEqual({ agentId: "main", provenance: null });
      expect(tableExists(openOpenClawStateDatabase(options).db, "agent_provenance")).toBe(
        provenanceTable === "present",
      );
      assertMatches(legacy, true);

      await setProvenance(42);
      assertMatches(legacy, false);
      expect(await matchesAgentLifecycleBindingAsync(() => config, legacy, options)).toBe(false);
      const recreated = await capture();
      expect(recreated).toEqual({
        agentId: "main",
        provenance: {
          agentId: "main",
          createdVia: "operator",
          creatorAgentId: null,
          createdAtMs: 42,
        },
      });
      const mutableBinding = structuredClone(recreated);
      const mutableOptions = { env: { ...options.env } };
      const otherEnv = {
        ...options.env,
        OPENCLAW_STATE_DIR: path.join(options.env.OPENCLAW_STATE_DIR, "other-state"),
      };
      recordAgentDatabaseAdmissions(
        [
          createAgentDatabaseInspectionRefusal({
            agentId: "main",
            paths: [],
            reason: "Synthetic other-source refusal",
          }),
        ],
        { env: otherEnv },
      );
      try {
        const originalCapture = captureAgentLifecycleBinding(() => config, "main", mutableOptions);
        const originalMatch = matchesAgentLifecycleBindingAsync(
          () => config,
          mutableBinding,
          mutableOptions,
        );
        mutableOptions.env.OPENCLAW_STATE_DIR = otherEnv.OPENCLAW_STATE_DIR;
        mutableBinding.provenance!.createdAtMs = 99;
        expect(await originalCapture).toEqual(recreated);
        expect(await originalMatch).toBe(true);
      } finally {
        recordAgentDatabaseAdmissions([], { env: otherEnv });
      }
      await setProvenance(43);
      assertMatches(recreated, false);
      await setProvenance(42);
      assertMatches(recreated, true);
      beginAgentDeletionJournal(
        { ...createEntry(), operationId: "owner-deletion", deleteFiles: false },
        options,
      );
      assertMatches(recreated, false);
      expect(await matchesAgentLifecycleBindingAsync(() => config, recreated, options)).toBe(false);
      runOpenClawStateWriteTransaction(
        (current) => deleteAgentDeletionJournalInDatabase(current, "main", "owner-deletion", false),
        options,
      );
      assertMatches(recreated, true);

      const capturing = captureAgentLifecycleBinding(() => config, "main", options);
      const matching = matchesAgentLifecycleBindingAsync(() => config, recreated, options);
      config = { agents: { entries: {} } };
      expect(await capturing).toBeUndefined();
      expect(await matching).toBe(false);
    },
  );

  it.each(["finish", "rollback"] as const)(
    "fences stale deletion owners and preserves provenance through recovery %s",
    async (action) => {
      const config = { agents: { entries: { main: {}, kept: {} } } };
      await setProvenance(1, "main", "template");
      await setProvenance(undefined, "kept");
      const before = readProvenance();
      const binding = await captureAgentLifecycleBinding(() => config, "main", options);
      const first = await withAgentDeletion(async (begin) => begin(createEntry("MAIN")), "MAIN");

      expect(readProvenance()).toEqual(before);
      expect(journal("MAIN")).toMatchObject({ agentId: "main", agentDir: "/agents/MAIN" });
      expect(blocked()).toBe(true);
      await expect(first.assertCurrentAsync()).rejects.toThrow("no longer owns");
      await expect(first.retire()).rejects.toThrow("no longer owns");
      await expect(first.fenceDatabasePaths([])).rejects.toThrow("no longer owns");
      await expect(first.fenceCleanupPaths([])).rejects.toThrow("no longer owns");
      expect(first.assertCurrentFinal).toThrow("no longer owns");
      expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(false);
      expect(await captureAgentLifecycleBinding(() => config, "main", options)).toBeUndefined();

      const recovery = await withAgentDeletion(async (begin) => {
        const deletion = await begin(createEntry());
        await expect(first[action]()).rejects.toThrow("no longer owns");
        expect(readProvenance()).toEqual(before);
        expect(journal("MAIN")).toMatchObject({
          agentId: "main",
          operationId: deletion.entry.operationId,
        });
        expect(blocked()).toBe(true);
        await deletion[action]();
        if (action === "finish") {
          expect(journal()).toMatchObject({ cleanupCompleted: true });
          expect(blocked()).toBe(true);
        } else {
          expect(journal()).toBeUndefined();
          expect(blocked()).toBe(false);
        }
        return deletion;
      });
      expect(readProvenance()).toEqual(action === "rollback" ? before : undefined);
      expect(readProvenance("kept")?.createdVia).toBe("operator");

      if (action === "finish") {
        expect(journal()).toMatchObject({ cleanupCompleted: true });
        expect(blocked()).toBe(true);
        expect(await claimCompletedAgentDeletion("main", recovery.entry.operationId, options)).toBe(
          true,
        );
        expect(journal()).toBeUndefined();
        expect(blocked()).toBe(false);
      }
      await setProvenance(2);
      await expect(first.finish()).rejects.toThrow("no longer owns");
      await expect(recovery.finish()).rejects.toThrow("no longer owns");
      expect(readProvenance()?.createdAtMs).toBe(2);
      expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(false);
    },
  );

  it("retains pre-resolved cleanup targets when recovery claims the journal", async () => {
    const databasePath = path.join(options.env.OPENCLAW_STATE_DIR, "recovery-agent.sqlite");
    const cleanupPaths = (
      [
        ["/real", "target", 1],
        ["/linked", "symlink", 2],
      ] as const
    ).map(([parentPath, kind, ino]) => ({
      path: `${parentPath}/workspace`,
      canonicalPath: `${parentPath}/workspace`,
      parentPath,
      kind,
      sourcePaths: ["/linked/workspace"],
      dev: 1,
      ino,
      coversDescendants: kind === "target",
      done: false,
    }));
    await withoutHostSql(async () => {
      await withAgentDeletion(async (begin) => {
        const deletion = await begin(createEntry("cleanup-recovery-agent"));
        await deletion.fenceDatabasePaths([databasePath]);
        await deletion.fenceCleanupPaths(cleanupPaths);
      }, "cleanup-recovery-agent");
      await withAgentDeletion(async (begin) => {
        const recovery = await begin(createEntry("cleanup-recovery-agent"));
        expect(recovery.entry.cleanupPaths).toEqual(cleanupPaths);
        expect(recovery.entry.databasePaths).toEqual([databasePath]);
        await recovery.rollback();
      }, "cleanup-recovery-agent");
    });
    expect(journal("cleanup-recovery-agent")).toBeUndefined();
  });

  it("allows refusal without a journal and revokes retained admission after settlement", async () => {
    const retained = await withAgentDeletion(async (begin) => begin);
    expect(journal()).toBeUndefined();
    await expect(retained(createEntry())).rejects.toThrow("no longer owns");
    await withAgentDeletion(async (begin) => {
      const deletion = await begin(createEntry());
      await expect(begin(createEntry())).rejects.toThrow("already began or has a different target");
      await deletion.rollback();
    });
  });
});
