import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
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
import { requireOpenClawStateDatabaseIdentity } from "../state/openclaw-state-db-cache.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { readAgentProvenance } from "../test-utils/agent-provenance.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  captureAgentLifecycleBinding,
  claimCompletedAgentDeletion,
  isAgentDeletionBlocked,
  matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
  withAgentDeletion as withAgentDeletionRuntime,
  type AgentLifecycleBinding,
} from "./agent-lifecycle-registry.js";

const tempDirs: string[] = [];

async function withAgentDeletion<T>(
  ...[agentId, run, options]: Parameters<typeof withAgentDeletionRuntime<T>>
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

function createOptions() {
  const stateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-delete-")),
  );
  tempDirs.push(stateDir);
  const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  openOpenClawStateDatabase(options);
  return options;
}

function createEntry(agentId: string) {
  return {
    agentId,
    agentDir: `/agents/${agentId}`,
    workspaceDir: `/workspaces/${agentId}`,
    sessionsDir: `/sessions/${agentId}`,
  };
}

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
      const options = createOptions();
      const original = beginAgentDeletionJournal(
        { ...createEntry(agentId), operationId: "invalid-system-deletion", deleteFiles: true },
        options,
      );
      const cleanup = vi.fn();
      await expect(
        Promise.resolve().then(() => withAgentDeletionRuntime(agentId, cleanup, options)),
      ).rejects.toThrow(`System agent ${agentId} cannot be deleted`);
      expect(cleanup).not.toHaveBeenCalled();
      expect(readAgentDeletionJournal(agentId, options)).toEqual(original);
    },
  );

  it("revalidates incarnation and deletion through its current transaction and restores authority after rollback", async () => {
    const options = createOptions();
    const config = { agents: { entries: { main: {} } } };
    await recordAgentProvenance("main", { createdVia: "operator" }, { ...options, nowMs: 1 });
    const binding = (await captureAgentLifecycleBinding(() => config, "main", options))!;
    const rollback = new Error("rollback authority changes");
    expect(() =>
      runOpenClawStateWriteTransaction((database) => {
        recordAgentProvenanceInDatabase(database.db, {
          agentId: "main",
          createdVia: "operator",
          creatorAgentId: null,
          createdAtMs: 2,
        });
        expect(matchesAgentLifecycleBinding(config, binding, options)).toBe(false);
        const provenance = readAgentProvenance("main", options);
        expect(provenance?.createdAtMs).toBe(2);
        const currentBinding = { ...binding, provenance: provenance ?? null };
        expect(matchesAgentLifecycleBinding(config, currentBinding, options)).toBe(true);
        beginAgentDeletionJournal(
          { ...createEntry("main"), operationId: "delete-main", deleteFiles: false },
          options,
        );
        expect(isAgentDeletionBlocked("main", options)).toBe(true);
        expect(matchesAgentLifecycleBinding(config, currentBinding, options)).toBe(false);
        throw rollback;
      }, options),
    ).toThrow(rollback);
    expect(isAgentDeletionBlocked("main", options)).toBe(false);
    expect(matchesAgentLifecycleBinding(config, binding, options)).toBe(true);
  });

  it.each(["commit", "rollback"] as const)(
    "revokes only the captured agent's cron runs after deletion journal %s",
    async (outcome) => {
      const options = createOptions();
      const otherOptions = createOptions();
      const identity = requireOpenClawStateDatabaseIdentity(openOpenClawStateDatabase(options)).key;
      const otherIdentity = requireOpenClawStateDatabaseIdentity(
        openOpenClawStateDatabase(otherOptions),
      ).key;
      const cleanups: Array<() => void> = [];
      const admit = (jobId: string, agentId: string, stateIdentityKey: string) => {
        const marker = markCronJobActive(jobId, { agentId, stateIdentityKey });
        const controller = new AbortController();
        const unregister = registerActiveCronTaskRun({
          runId: `${jobId}-${cleanups.length}`,
          controller,
          activeJobMarker: marker,
        });
        cleanups.push(() => {
          unregister?.();
          clearCronJobActive(jobId, marker);
        });
        return controller.signal;
      };
      const target = admit("deleted-agent-run", "main", identity);
      const otherAgent = admit("other-agent-run", "kept", identity);
      const otherState = admit("other-state-run", "main", otherIdentity);
      const retired = admit("replaced-run", "main", identity);
      let successor: AbortSignal | undefined;
      const runWorker = stateWorker.runOpenClawStateWorkerOperation;
      const beforeBegin = vi
        .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
        .mockImplementation((context, run, workerOptions) => {
          let beginning = false;
          const createAdmission = workerOptions?.createAdmission;
          return runWorker(
            context,
            (scope) =>
              run({
                ...scope,
                execute: async (command, executeOptions) => {
                  beginning = command.type === "agentDeletion.begin";
                  if (beginning) {
                    expect(target.aborted).toBe(false);
                    successor = admit("replaced-run", "main", identity);
                  }
                  return scope.execute(command, executeOptions);
                },
              }),
            {
              ...workerOptions,
              ...(createAdmission
                ? {
                    createAdmission: (retained: RetainedWorkerTransactionAdmission) => {
                      const created = createAdmission(retained);
                      if (beginning && outcome === "rollback") {
                        created.admission.observeRequests((request) => {
                          if (request.stage === "commit") {
                            throw new Error("rollback journal admission");
                          }
                        });
                      }
                      return created;
                    },
                  }
                : {}),
            },
          );
        });
      try {
        await withAgentDeletion(
          "main",
          async (begin) => {
            if (outcome === "rollback") {
              await expect(begin(createEntry("main"))).rejects.toThrow(
                "rollback journal admission",
              );
            } else {
              await begin(createEntry("main"));
            }
            expect(target.aborted).toBe(outcome === "commit");
            expect(otherAgent.aborted).toBe(false);
            expect(otherState.aborted).toBe(false);
            expect(retired.aborted).toBe(false);
            expect(successor?.aborted).toBe(false);
          },
          options,
        );
      } finally {
        beforeBegin.mockRestore();
        for (const cleanup of cleanups.toReversed()) {
          cleanup();
        }
      }
    },
  );

  it("publishes committed deletion facts and revokes cleanup even when replies are lost", async () => {
    const options = createOptions();
    const identity = requireOpenClawStateDatabaseIdentity(openOpenClawStateDatabase(options)).key;
    const marker = markCronJobActive("lost-delete-reply", {
      agentId: "main",
      stateIdentityKey: identity,
    });
    const controller = new AbortController();
    const releaseRun = registerActiveCronTaskRun({
      runId: "lost-delete-run",
      controller,
      activeJobMarker: marker,
    });
    const changes: unknown[] = [];
    const unsubscribe = sessionChanges.subscribe((change) => {
      if (isSessionStoreTopologyChange(change)) {
        changes.push(change);
      }
    });
    let failCommand: string | undefined = "agentDeletion.begin";
    const runWorker = stateWorker.runOpenClawStateWorkerOperation;
    const lostReply = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, run, workerOptions) =>
        runWorker(
          context,
          (scope) =>
            run({
              ...scope,
              execute: async (command, executeOptions) => {
                const result = await scope.execute(command, executeOptions);
                if (command.type === failCommand) {
                  failCommand = undefined;
                  throw new Error("synthetic reply lost after native commit");
                }
                return result;
              },
            }),
          workerOptions,
        ),
      );
    try {
      await withAgentDeletion(
        "main",
        async (begin) => {
          await expect(begin(createEntry("main"))).rejects.toThrow("synthetic reply lost");
          expect(controller.signal.aborted).toBe(true);
          expect(changes).toHaveLength(1);
          expect(readAgentDeletionJournal("main", options)).toMatchObject({
            cleanupCompleted: false,
          });
        },
        options,
      );
      await withAgentDeletion(
        "main",
        async (begin) => {
          const deletion = await begin(createEntry("main"));
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
          expect(readAgentDeletionJournal("main", options)).toMatchObject({
            cleanupCompleted: true,
          });
          expect(changes).toHaveLength(2);
        },
        options,
      );
    } finally {
      lostReply.mockRestore();
      unsubscribe();
      releaseRun?.();
      clearCronJobActive("lost-delete-reply", marker);
    }
  });

  it("does not recreate a missing mandatory deletion journal while reading authority", () => {
    const options = createOptions();
    expect(readAgentDeletionJournal("main", options)).toBeUndefined();
    const database = openOpenClawStateDatabase(options);
    database.db.exec("DROP TABLE agent_deletion_journal");
    expect(() => readAgentDeletionJournal("main", options)).toThrow(
      "Agent deletion journal missing; run openclaw doctor --fix",
    );
    expect(isAgentDeletionBlocked("main", options)).toBe(false);
    runOpenClawStateWriteTransaction((current) => {
      expect(isAgentDeletionBlocked("main", options, current.db)).toBe(false);
      expect(tableExists(current.db, "agent_deletion_journal")).toBe(false);
    }, options);
    expect(tableExists(database.db, "agent_deletion_journal")).toBe(false);
  });

  it("reads current deletion authority outside an inherited discovery snapshot", async () => {
    const options = createOptions();
    const config = { agents: { entries: { main: {} } } };
    await recordAgentProvenance("main", { createdVia: "operator" }, options);
    const binding = await captureAgentLifecycleBinding(() => config, "main", options);
    await withOpenClawStateDatabaseReadSnapshot(async () => {
      await withAgentDeletion(
        "main",
        async (begin) => {
          const deletion = await begin(createEntry("main"));
          expect(await captureAgentLifecycleBinding(() => config, "main", options)).toBeUndefined();
          expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(false);
          const observation = observeHostDataSql(() => {
            throw new Error("Deletion authority must not execute SQL on the parent");
          });
          try {
            await deletion.assertCurrentAsync();
            expect(observation.queries).toEqual([]);
          } finally {
            observation.restore();
          }
          await deletion.rollback();
          expect(readAgentDeletionJournal("main", options)).toBeUndefined();
          await expect(deletion.assertCurrentAsync()).rejects.toThrow("no longer owns");
          expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(true);
        },
        options,
      );
    }, options);
  });

  it("refuses changed journal authority before filesystem effects while the original deletion lease is held", async () => {
    const options = createOptions();
    await withAgentDeletion(
      "main",
      async (begin) => {
        const entry = createEntry("main");
        const deletion = await begin(entry);
        const { db } = openOpenClawStateDatabase(options);
        const effectPath = path.join(options.env.OPENCLAW_STATE_DIR, "cleanup-effect");
        const writeEffect = () => {
          deletion.assertCurrentFinal();
          fs.writeFileSync(effectPath, "cleanup accepted");
        };
        for (const mutation of [
          "UPDATE agent_deletion_journal SET operation_id = 'replacement' WHERE agent_id = 'main'",
          "UPDATE agent_deletion_journal SET cleanup_completed = 1 WHERE agent_id = 'main'",
          "UPDATE agent_deletion_journal SET cleanup_completed = 2 WHERE agent_id = 'main'",
          "DELETE FROM agent_deletion_journal WHERE agent_id = 'main'",
        ]) {
          await deletion.assertCurrentAsync();
          // A committed external change cannot be hidden by an earlier discovery snapshot.
          db.exec(mutation);
          expect(writeEffect).toThrow();
          expect(fs.existsSync(effectPath)).toBe(false);
          await expect(deletion.assertCurrentAsync()).rejects.toThrow();
          beginAgentDeletionJournal(
            { ...entry, operationId: deletion.entry.operationId, deleteFiles: true },
            options,
          );
        }
        await deletion.assertCurrentAsync();
        const executed: string[] = [];
        const observation = observeHostDataSql((sql, database) => {
          if (database === undefined) {
            executed.push(sql);
          }
        });
        try {
          writeEffect();
          expect(executed.filter((sql) => /\bagent_deletion_journal\b/i.test(sql))).toHaveLength(1);
          expect(
            observation.queries.some((sql) =>
              /^\s*(?:begin|commit|rollback|savepoint)\b/i.test(sql),
            ),
          ).toBe(false);
        } finally {
          observation.restore();
        }
        expect(fs.readFileSync(effectPath, "utf8")).toBe("cleanup accepted");
        await deletion.rollback();
      },
      options,
    );
  });

  it("refuses a stolen lease before filesystem effects and rechecks it in the heartbeat worker", async () => {
    const options = createOptions();
    await expect(
      withAgentDeletion(
        "main",
        async (begin) => {
          const deletion = await begin(createEntry("main"));
          await deletion.assertCurrentAsync();
          openOpenClawStateDatabase(options)
            .db.prepare("UPDATE state_leases SET owner = ? WHERE scope = ? AND lease_key = ?")
            .run("successor", "core:agent-deletion", "main");
          const effectPath = path.join(options.env.OPENCLAW_STATE_DIR, "cleanup-effect");
          expect(() => {
            deletion.assertCurrentFinal();
            fs.writeFileSync(effectPath, "cleanup accepted");
          }).toThrow();
          expect(fs.existsSync(effectPath)).toBe(false);
          const observation = observeHostDataSql(() => {
            throw new Error("Deletion authority must not execute SQL on the parent");
          });
          try {
            await expect(deletion.assertCurrentAsync()).rejects.toMatchObject({
              code: "OPENCLAW_STATE_LEASE_LOST",
            });
            expect(observation.queries).toEqual([]);
          } finally {
            observation.restore();
          }
        },
        options,
      ),
    ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
  });

  it("rejects a current worker reply when deletion closes before the reply is consumed", async () => {
    const options = createOptions();
    await withAgentDeletion(
      "main",
      async (begin) => {
        const deletion = await begin(createEntry("main"));
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
      },
      options,
    );
  });

  it("preserves recovery holds through rollback and failed completion, then transfers protection to retained deletion", async () => {
    const options = createOptions();
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
    await recordAgentProvenance(target.agentId, { createdVia: "operator" }, options);
    const provenance = readAgentProvenance(target.agentId, options);
    await withAgentDeletion(
      target.agentId,
      async (begin) => {
        await (await begin(entry)).rollback();
      },
      options,
    );
    expect(readAgentDeletionJournal(target.agentId, options)).toBeUndefined();
    expect(readHolds()).toEqual(held);
    expect(isAgentDeletionBlocked(target.agentId, options)).toBe(false);
    const leaseId = claimOpenClawAgentDatabaseLease({ ...target, ...options });
    releaseOpenClawAgentDatabaseLease(leaseId, options, "read-only");
    expect(readHolds()).toEqual(held);

    const runWorker = stateWorker.runOpenClawStateWorkerOperation;
    const refuseCompletion = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, run, workerOptions) => {
        let completing = false;
        const createAdmission = workerOptions?.createAdmission;
        return runWorker(
          context,
          (scope) =>
            run({
              ...scope,
              execute: async (command, executeOptions) => {
                completing = command.type === "agentDeletion.finish";
                return scope.execute(command, executeOptions);
              },
            }),
          {
            ...workerOptions,
            ...(createAdmission
              ? {
                  createAdmission: (retained: RetainedWorkerTransactionAdmission) => {
                    const created = createAdmission(retained);
                    if (completing) {
                      created.admission.observeRequests((request) => {
                        if (request.stage === "commit") {
                          throw new Error("completion transaction failed");
                        }
                      });
                    }
                    return created;
                  },
                }
              : {}),
          },
        );
      });
    try {
      await expect(
        withAgentDeletion(
          target.agentId,
          async (begin) => {
            const deletion = await begin(entry);
            await deletion.finish();
          },
          options,
        ),
      ).rejects.toThrow("completion transaction failed");
    } finally {
      refuseCompletion.mockRestore();
    }
    expect(readAgentDeletionJournal(target.agentId, options)).toMatchObject({
      cleanupCompleted: false,
    });
    expect(readHolds()).toEqual(held);
    expect(readAgentProvenance(target.agentId, options)).toEqual(provenance);

    const observation = observeHostDataSql();
    try {
      await withAgentDeletion(
        target.agentId,
        async (begin) => {
          await (await begin(entry)).finish();
        },
        options,
      );
      expect(observation.queries).toEqual([]);
    } finally {
      observation.restore();
    }
    expect(readHolds()).toEqual(held.slice(1));
    expect(readAgentDeletionJournal(target.agentId, options)).toMatchObject({
      cleanupCompleted: true,
      deleteFiles: false,
    });
    expect(() =>
      openOpenClawAgentDatabase({ ...options, agentId: target.agentId, path: target.path }),
    ).toThrow("deleted");
    expect(held.map((store) => fs.readFileSync(store.path))).toEqual(originalBytes);
  });

  it.each(["present", "absent"] as const)(
    "captures without host SQL and observes foreign lifecycle commits with provenance table %s",
    async (provenanceTable) => {
      const options = createOptions();
      if (provenanceTable === "absent") {
        openOpenClawStateDatabase(options).db.exec("DROP TABLE agent_provenance");
        await closeStateDatabaseForTest();
        openOpenClawStateDatabase(options);
      }
      let config: OpenClawConfig = { agents: { entries: { main: {} } } };
      const capture = async () => {
        const observation = observeHostDataSql();
        try {
          const binding = await captureAgentLifecycleBinding(() => config, "MAIN", options);
          expect(binding).toBeDefined();
          expect(await matchesAgentLifecycleBindingAsync(() => config, binding!, options)).toBe(
            true,
          );
          expect(observation.queries).toEqual([]);
          return binding!;
        } finally {
          observation.restore();
        }
      };
      const assertMatches = (binding: AgentLifecycleBinding, expected: boolean) => {
        const executed: string[] = [];
        const observation = observeHostDataSql((sql, database) => {
          if (database === undefined) {
            executed.push(sql);
          }
        });
        try {
          expect(matchesAgentLifecycleBinding(config, binding, options)).toBe(expected);
          const authorityReads = executed.filter((sql) =>
            /\bagent_(?:provenance|deletion_journal)\b/i.test(sql),
          );
          expect(authorityReads).toHaveLength(1);
          expect(authorityReads[0]).not.toMatch(
            /\*|\b(?:database_paths_json|cleanup_paths_json)\b/i,
          );
          expect(
            observation.queries.some((sql) =>
              /^\s*(?:begin|commit|rollback|savepoint)\b/i.test(sql),
            ),
          ).toBe(false);
        } finally {
          observation.restore();
        }
      };
      const legacy = await capture();
      expect(legacy).toEqual({ agentId: "main", provenance: null });
      expect(tableExists(openOpenClawStateDatabase(options).db, "agent_provenance")).toBe(
        provenanceTable === "present",
      );
      expect(matchesAgentLifecycleBinding(config, legacy, options)).toBe(true);
      assertMatches(legacy, true);

      await recordAgentProvenance("main", { createdVia: "operator" }, { ...options, nowMs: 42 });
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
      const database = openOpenClawStateDatabase(options);
      database.db.exec("UPDATE agent_provenance SET created_at_ms = 43 WHERE agent_id = 'main'");
      assertMatches(recreated, false);
      database.db.exec("UPDATE agent_provenance SET created_at_ms = 42 WHERE agent_id = 'main'");
      assertMatches(recreated, true);
      beginAgentDeletionJournal(
        { ...createEntry("main"), operationId: "foreign-deletion", deleteFiles: false },
        options,
      );
      assertMatches(recreated, false);
      expect(await matchesAgentLifecycleBindingAsync(() => config, recreated, options)).toBe(false);
      database.db.exec("DELETE FROM agent_deletion_journal WHERE agent_id = 'main'");
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
      const options = createOptions();
      const config = { agents: { entries: { main: {}, kept: {} } } };
      await recordAgentProvenance("main", { createdVia: "claw" }, { ...options, nowMs: 1 });
      await recordAgentProvenance("kept", { createdVia: "operator" }, options);
      const before = readAgentProvenance("main", options);
      const binding = await captureAgentLifecycleBinding(() => config, "main", options);
      const first = await withAgentDeletion(
        "MAIN",
        async (begin) => begin(createEntry("MAIN")),
        options,
      );

      expect(readAgentProvenance("main", options)).toEqual(before);
      expect(readAgentDeletionJournal("MAIN", options)).toMatchObject({
        agentId: "main",
        agentDir: "/agents/MAIN",
      });
      expect(isAgentDeletionBlocked("main", options)).toBe(true);
      await expect(first.assertCurrentAsync()).rejects.toThrow("no longer owns");
      await expect(first.retire()).rejects.toThrow("no longer owns");
      await expect(first.fenceDatabasePaths([])).rejects.toThrow("no longer owns");
      await expect(first.fenceCleanupPaths([])).rejects.toThrow("no longer owns");
      expect(first.assertCurrentFinal).toThrow("no longer owns");
      expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(false);
      expect(await captureAgentLifecycleBinding(() => config, "main", options)).toBeUndefined();

      const recovery = await withAgentDeletion(
        "main",
        async (begin) => {
          const deletion = await begin(createEntry("main"));
          await expect(first[action]()).rejects.toThrow("no longer owns");
          expect(readAgentProvenance("main", options)).toEqual(before);
          expect(readAgentDeletionJournal("MAIN", options)).toMatchObject({
            agentId: "main",
            operationId: deletion.entry.operationId,
          });
          expect(isAgentDeletionBlocked("main", options)).toBe(true);
          await deletion[action]();
          if (action === "finish") {
            expect(readAgentDeletionJournal("main", options)).toMatchObject({
              cleanupCompleted: true,
            });
            expect(isAgentDeletionBlocked("main", options)).toBe(true);
          } else {
            expect(readAgentDeletionJournal("main", options)).toBeUndefined();
            expect(isAgentDeletionBlocked("main", options)).toBe(false);
          }
          return deletion;
        },
        options,
      );
      expect(readAgentProvenance("main", options)).toEqual(
        action === "rollback" ? before : undefined,
      );
      expect(readAgentProvenance("kept", options)?.createdVia).toBe("operator");

      if (action === "finish") {
        expect(readAgentDeletionJournal("main", options)).toMatchObject({ cleanupCompleted: true });
        expect(isAgentDeletionBlocked("main", options)).toBe(true);
        expect(await claimCompletedAgentDeletion("main", recovery.entry.operationId, options)).toBe(
          true,
        );
        expect(readAgentDeletionJournal("main", options)).toBeUndefined();
        expect(isAgentDeletionBlocked("main", options)).toBe(false);
      }
      await recordAgentProvenance("main", { createdVia: "operator" }, { ...options, nowMs: 2 });
      await expect(first.finish()).rejects.toThrow("no longer owns");
      await expect(recovery.finish()).rejects.toThrow("no longer owns");
      expect(readAgentProvenance("main", options)?.createdAtMs).toBe(2);
      expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(false);
    },
  );

  it("retains pre-resolved cleanup targets when recovery claims the journal", async () => {
    const options = createOptions();
    const databasePath = path.join(options.env.OPENCLAW_STATE_DIR, "recovery-agent.sqlite");
    const cleanupPaths = [
      {
        path: "/real/workspace",
        canonicalPath: "/real/workspace",
        parentPath: "/real",
        kind: "target" as const,
        sourcePaths: ["/linked/workspace"],
        dev: 1,
        ino: 1,
        coversDescendants: true,
        done: false,
      },
      {
        path: "/linked/workspace",
        canonicalPath: "/linked/workspace",
        parentPath: "/linked",
        kind: "symlink" as const,
        sourcePaths: ["/linked/workspace"],
        dev: 1,
        ino: 2,
        coversDescendants: false,
        done: false,
      },
    ];
    const observation = observeHostDataSql();
    try {
      await withAgentDeletion(
        "cleanup-recovery-agent",
        async (begin) => {
          const deletion = await begin(createEntry("cleanup-recovery-agent"));
          await deletion.fenceDatabasePaths([databasePath]);
          await deletion.fenceCleanupPaths(cleanupPaths);
        },
        options,
      );
      await withAgentDeletion(
        "cleanup-recovery-agent",
        async (begin) => {
          const recovery = await begin(createEntry("cleanup-recovery-agent"));
          expect(recovery.entry.cleanupPaths).toEqual(cleanupPaths);
          expect(recovery.entry.databasePaths).toEqual([databasePath]);
          await recovery.rollback();
        },
        options,
      );
      expect(observation.queries).toEqual([]);
    } finally {
      observation.restore();
    }
    expect(readAgentDeletionJournal("cleanup-recovery-agent", options)).toBeUndefined();
  });

  it("allows refusal without a journal and revokes retained admission after settlement", async () => {
    const options = createOptions();
    const retained = await withAgentDeletion("main", async (begin) => begin, options);
    expect(readAgentDeletionJournal("main", options)).toBeUndefined();
    await expect(retained(createEntry("main"))).rejects.toThrow("no longer owns");
    await withAgentDeletion(
      "main",
      async (begin) => {
        const deletion = await begin(createEntry("main"));
        await expect(begin(createEntry("main"))).rejects.toThrow(
          "already began or has a different target",
        );
        await deletion.rollback();
      },
      options,
    );
  });
});
