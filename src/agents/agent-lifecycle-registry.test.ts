import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { clearCronJobActive, markCronJobActive } from "../cron/active-jobs.js";
import { registerActiveCronTaskRun } from "../cron/service/active-run-cancellation.js";
import { createDeferredCore } from "../shared/deferred.js";
import { reconstructAgentDeletionJournal } from "../state/agent-deletion-journal-recovery.js";
import { readAgentDeletionRecoveryHolds } from "../state/agent-deletion-journal-recovery.kernel.js";
import {
  beginAgentDeletionJournal,
  claimCompletedAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../state/agent-deletion-journal.js";
import * as journalAuthorityReads from "../state/agent-deletion-journal.read.js";
import { readAgentProvenance, recordAgentProvenance } from "../state/agent-provenance.js";
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
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  captureAgentLifecycleBinding,
  claimCompletedAgentDeletion,
  isAgentDeletionBlocked,
  matchesAgentLifecycleBinding,
  withAgentDeletion as withAgentDeletionRuntime,
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

  it("revalidates incarnation and deletion through its current transaction and restores authority after rollback", () => {
    const options = createOptions();
    const config = { agents: { entries: { main: {} } } };
    recordAgentProvenance("main", { createdVia: "operator" }, { ...options, nowMs: 1 });
    const binding = captureAgentLifecycleBinding(config, "main", options)!;
    const rollback = new Error("rollback authority changes");
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        recordAgentProvenance("main", { createdVia: "operator" }, { ...options, nowMs: 2 });
        expect(matchesAgentLifecycleBinding(config, binding, options)).toBe(false);
        expect(captureAgentLifecycleBinding(config, "main", options)?.provenance?.createdAtMs).toBe(
          2,
        );
        beginAgentDeletionJournal(
          { ...createEntry("main"), operationId: "delete-main", deleteFiles: false },
          options,
        );
        expect(isAgentDeletionBlocked("main", options)).toBe(true);
        expect(captureAgentLifecycleBinding(config, "main", options)).toBeUndefined();
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
      try {
        await withAgentDeletion(
          "main",
          async (begin) => {
            const mutate = () =>
              runOpenClawStateWriteTransaction(() => {
                begin(createEntry("main"));
                expect(target.aborted).toBe(false);
                successor = admit("replaced-run", "main", identity);
                if (outcome === "rollback") {
                  throw new Error("rollback journal admission");
                }
              }, options);
            if (outcome === "rollback") {
              expect(mutate).toThrow("rollback journal admission");
            } else {
              mutate();
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
        for (const cleanup of cleanups.toReversed()) {
          cleanup();
        }
      }
    },
  );

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
    recordAgentProvenance("main", { createdVia: "operator" }, options);
    const binding = captureAgentLifecycleBinding(config, "main", options);
    await withOpenClawStateDatabaseReadSnapshot(async () => {
      await withAgentDeletion(
        "main",
        async (begin) => {
          const deletion = begin(createEntry("main"));
          expect(captureAgentLifecycleBinding(config, "main", options)).toBeUndefined();
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
          deletion.rollback();
          expect(readAgentDeletionJournal("main", options)).toBeUndefined();
          await expect(deletion.assertCurrentAsync()).rejects.toThrow("no longer owns");
          expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(true);
        },
        options,
      );
    }, options);
  });

  it("refuses changed journal authority while the original deletion lease is still held", async () => {
    const options = createOptions();
    await withAgentDeletion(
      "main",
      async (begin) => {
        const entry = createEntry("main");
        const deletion = begin(entry);
        const { db } = openOpenClawStateDatabase(options);
        await deletion.assertCurrentAsync();
        for (const mutation of [
          "UPDATE agent_deletion_journal SET operation_id = 'replacement' WHERE agent_id = 'main'",
          "UPDATE agent_deletion_journal SET cleanup_completed = 1 WHERE agent_id = 'main'",
          "UPDATE agent_deletion_journal SET cleanup_completed = 2 WHERE agent_id = 'main'",
          "DELETE FROM agent_deletion_journal WHERE agent_id = 'main'",
        ]) {
          // A committed external change cannot be hidden by an earlier discovery snapshot.
          db.exec(mutation);
          await expect(deletion.assertCurrentAsync()).rejects.toThrow();
          beginAgentDeletionJournal(
            { ...entry, operationId: deletion.entry.operationId, deleteFiles: true },
            options,
          );
          await deletion.assertCurrentAsync();
        }
        deletion.rollback();
      },
      options,
    );
  });

  it("refuses a stolen lease through the heartbeat worker without querying on the parent", async () => {
    const options = createOptions();
    await expect(
      withAgentDeletion(
        "main",
        async (begin) => {
          const deletion = begin(createEntry("main"));
          await deletion.assertCurrentAsync();
          openOpenClawStateDatabase(options)
            .db.prepare("UPDATE state_leases SET owner = ? WHERE scope = ? AND lease_key = ?")
            .run("successor", "core:agent-deletion", "main");
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
        const deletion = begin(createEntry("main"));
        const read = journalAuthorityReads.readAgentDeletionJournalAuthorityInWorker;
        const entered = createDeferredCore();
        const resume = createDeferredCore();
        const heldRead = vi
          .spyOn(journalAuthorityReads, "readAgentDeletionJournalAuthorityInWorker")
          .mockImplementation(async (...args) => {
            const authority = await read(...args);
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
          deletion.rollback();
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
    await withAgentDeletion(
      target.agentId,
      async (begin) => {
        begin(entry).rollback();
      },
      options,
    );
    expect(readAgentDeletionJournal(target.agentId, options)).toBeUndefined();
    expect(readHolds()).toEqual(held);
    expect(isAgentDeletionBlocked(target.agentId, options)).toBe(false);
    const leaseId = claimOpenClawAgentDatabaseLease({ ...target, ...options });
    releaseOpenClawAgentDatabaseLease(leaseId, options, "read-only");
    expect(readHolds()).toEqual(held);

    await expect(
      withAgentDeletion(
        target.agentId,
        async (begin) => {
          const deletion = begin(entry);
          runOpenClawStateWriteTransaction((database) => {
            deletion.completeInTransaction(database);
            throw new Error("completion transaction failed");
          }, options);
        },
        options,
      ),
    ).rejects.toThrow("completion transaction failed");
    expect(readAgentDeletionJournal(target.agentId, options)).toMatchObject({
      cleanupCompleted: false,
    });
    expect(readHolds()).toEqual(held);

    await withAgentDeletion(
      target.agentId,
      async (begin) => {
        begin(entry).finish();
      },
      options,
    );
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

  it("binds legacy and recreated agents to distinct durable incarnations", () => {
    const options = createOptions();
    const config = { agents: { entries: { main: {} } } };
    const legacy = captureAgentLifecycleBinding(config, "MAIN", options);

    expect(legacy).toEqual({ agentId: "main", provenance: null });
    expect(legacy && matchesAgentLifecycleBinding(config, legacy, options)).toBe(true);

    recordAgentProvenance("main", { createdVia: "operator" }, { ...options, nowMs: 42 });
    expect(legacy && matchesAgentLifecycleBinding(config, legacy, options)).toBe(false);
    const recreated = captureAgentLifecycleBinding(config, "main", options);
    expect(recreated).toEqual({
      agentId: "main",
      provenance: {
        agentId: "main",
        createdVia: "operator",
        creatorAgentId: null,
        createdAtMs: 42,
      },
    });
  });

  it.each(["finish", "transaction", "rollback"] as const)(
    "fences stale deletion owners and preserves provenance through recovery %s",
    async (action) => {
      const options = createOptions();
      const config = { agents: { entries: { main: {}, kept: {} } } };
      recordAgentProvenance("main", { createdVia: "claw" }, { ...options, nowMs: 1 });
      recordAgentProvenance("kept", { createdVia: "operator" }, options);
      const before = readAgentProvenance("main", options);
      const binding = captureAgentLifecycleBinding(config, "main", options);
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
      expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(false);
      expect(captureAgentLifecycleBinding(config, "main", options)).toBeUndefined();

      const recovery = await withAgentDeletion(
        "main",
        async (begin) => {
          const deletion = begin(createEntry("main"));
          const staleAction = action === "rollback" ? "rollback" : "finish";
          expect(() => first[staleAction]()).toThrow("no longer owns");
          expect(readAgentProvenance("main", options)).toEqual(before);
          expect(readAgentDeletionJournal("MAIN", options)).toMatchObject({
            agentId: "main",
            operationId: deletion.entry.operationId,
          });
          expect(isAgentDeletionBlocked("main", options)).toBe(true);
          if (action === "transaction") {
            runOpenClawStateWriteTransaction(deletion.completeInTransaction, options);
          } else {
            deletion[action]();
          }
          if (action !== "rollback") {
            expect(readAgentDeletionJournal("main", options)).toMatchObject({
              cleanupCompleted: true,
            });
            expect(isAgentDeletionBlocked("main", options)).toBe(true);
            if (action === "finish") {
              expect(
                claimCompletedAgentDeletionJournal("main", deletion.entry.operationId, options),
              ).toBe(true);
            }
          }
          if (action !== "transaction") {
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

      if (action === "transaction") {
        expect(readAgentDeletionJournal("main", options)).toMatchObject({ cleanupCompleted: true });
        expect(isAgentDeletionBlocked("main", options)).toBe(true);
        expect(claimCompletedAgentDeletion("main", recovery.entry.operationId, options)).toBe(true);
        expect(readAgentDeletionJournal("main", options)).toBeUndefined();
        expect(isAgentDeletionBlocked("main", options)).toBe(false);
      }
      recordAgentProvenance("main", { createdVia: "operator" }, { ...options, nowMs: 2 });
      expect(() => first.finish()).toThrow("no longer owns");
      expect(() => recovery.finish()).toThrow("no longer owns");
      expect(readAgentProvenance("main", options)?.createdAtMs).toBe(2);
      expect(binding && matchesAgentLifecycleBinding(config, binding, options)).toBe(false);
    },
  );

  it("retains pre-resolved cleanup targets when recovery claims the journal", async () => {
    const options = createOptions();
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
    await withAgentDeletion(
      "cleanup-recovery-agent",
      async (begin) => {
        begin(createEntry("cleanup-recovery-agent")).fenceCleanupPaths(cleanupPaths);
      },
      options,
    );
    await withAgentDeletion(
      "cleanup-recovery-agent",
      async (begin) => {
        const recovery = begin(createEntry("cleanup-recovery-agent"));
        expect(recovery.entry.cleanupPaths).toEqual(cleanupPaths);
        expect(readAgentDeletionJournal("cleanup-recovery-agent", options)?.cleanupPaths).toEqual(
          cleanupPaths,
        );
        recovery.rollback();
      },
      options,
    );
  });

  it("allows refusal without a journal and revokes retained admission after settlement", async () => {
    const options = createOptions();
    const retained = await withAgentDeletion("main", async (begin) => begin, options);
    expect(readAgentDeletionJournal("main", options)).toBeUndefined();
    expect(() => retained(createEntry("main"))).toThrow("already began or has a different target");
    await withAgentDeletion(
      "main",
      async (begin) => {
        const deletion = begin(createEntry("main"));
        expect(() => begin(createEntry("main"))).toThrow("already began or has a different target");
        deletion.rollback();
      },
      options,
    );
  });
});
