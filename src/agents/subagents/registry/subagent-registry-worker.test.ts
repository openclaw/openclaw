import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { createContext as createGatewayContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import * as operationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-context-binding.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import * as workerContext from "../../../state/openclaw-state-worker-context.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { readSubagentRunAnnounceResultUsing } from "../announce/subagent-announce-result.js";
import {
  mutateRequesterSettleWakeBatch,
  settleRequesterCompletionBatch,
} from "../completion/subagent-completion-admission.store.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import {
  getSubagentRegistryPublicationRevision,
  subscribeSubagentRunChanges,
} from "./subagent-registry-publication.js";
import { recoverSubagentRunGatewayOwner } from "./subagent-registry-restore.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import { saveSubagentRegistryChangesToSqlite } from "./subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForRead,
  getSubagentMaintenanceRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForRead,
} from "./subagent-registry-state.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
  openOpenClawStateDatabase();
});
beforeEach(() => {
  subagentRuns.clear();
  clearSubagentRunsReadCacheForTest();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Restore also reconciles uncertain or source-superseded writes before deleting fixture rows.
  await restoreSubagentRunsFromDisk({ runs: subagentRuns });
  const runIds = [...subagentRuns.keys()];
  if (runIds.length) {
    await mutateSubagentRuns(runIds, () => ({
      value: undefined,
      postimages: new Map(runIds.map((runId) => [runId, null])),
    }));
  }
  subagentRuns.clear();
  clearSubagentRunsReadCacheForTest();
});
afterAll(async () => {
  await state.cleanup();
});

function entry(runId: string): SubagentRunRecord {
  return createSubagentRunRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:requester",
    createdAt: 1,
    completion: { required: false },
    delivery: { status: "not_required" },
  });
}

async function register(...entries: SubagentRunRecord[]) {
  await mutateSubagentRuns(
    entries.map((row) => row.runId),
    () => ({
      value: undefined,
      postimages: new Map(entries.map((row) => [row.runId, row])),
    }),
  );
}

function change(runId: string, update: (row: SubagentRunRecord) => void) {
  return mutateSubagentRuns([runId], (rows) => {
    const current = rows.get(runId);
    if (!current) {
      throw new Error("Missing test row");
    }
    const next = structuredClone(current);
    update(next);
    return { value: undefined, postimages: new Map([[runId, next]]) };
  });
}

function interceptWrites(callback: (phase: "before" | "after") => void | Promise<void>) {
  const execute = stateWorker.runOpenClawStateWorkerOperation;
  return vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, run, options) =>
      execute(
        context,
        (scope) =>
          run({
            execute: async (command, executeOptions) => {
              if (command.type === "subagents.persistChanges") {
                await callback("before");
              }
              const receipt = await scope.execute(command, executeOptions);
              if (command.type === "subagents.persistChanges") {
                await callback("after");
              }
              return receipt;
            },
          }),
        options,
      ),
    );
}

it("publishes overlapping same-row mutations in FIFO order after each real commit ACK", async () => {
  await register(entry("overlap"));
  const reached = createDeferredCore();
  const release = createDeferredCore();
  let held = false;
  interceptWrites(async (phase) => {
    if (phase === "after" && !held) {
      held = true;
      reached.resolve();
      await release.promise;
    }
  });
  const first = change("overlap", (row) => {
    row.label = "first mutation";
  });
  let second: Promise<void> | undefined;
  try {
    await awaitGateBeforeSettlement(
      reached.promise,
      first,
      "first commit did not reach its ACK gate",
    );
    expect(subagentRuns.get("overlap")?.label).toBeUndefined();
    const successorPlan = vi.fn((row: SubagentRunRecord) => {
      row.cleanupCompletedAt = 42;
    });
    second = change("overlap", successorPlan);
    expect(successorPlan).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([first, second]);
    expect(subagentRuns.get("overlap")).toMatchObject({
      label: "first mutation",
      cleanupCompletedAt: 42,
    });
    expect(loadSubagentRegistryFromSqlite().get("overlap")).toMatchObject({
      label: "first mutation",
      cleanupCompletedAt: 42,
    });
    expect(() => {
      subagentRuns.get("overlap")!.label = "uncommitted mutation";
    }).toThrow(TypeError);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
  }
});

it.each([false, true])(
  "replans a foreign connection change and rejects only semantic ownership loss (%s)",
  async (replaceOwner) => {
    await register(entry("foreign"));
    let injected = false;
    interceptWrites((phase) => {
      if (phase !== "before" || injected) {
        return;
      }
      injected = true;
      const foreign = loadSubagentRegistryFromSqlite().get("foreign")!;
      foreign.model = "foreign metadata";
      if (replaceOwner) {
        foreign.requesterSessionKey = "agent:main:new-requester";
      }
      // This fixture's admitted native handle is a different SQLite connection from the worker.
      saveSubagentRegistryChangesToSqlite(new Map([[foreign.runId, foreign]]), [foreign.runId]);
    });
    const plan = vi.fn((rows: ReadonlyMap<string, SubagentRunRecord>) => {
      const current = rows.get("foreign")!;
      if (current.requesterSessionKey !== "agent:main:requester") {
        throw new SubagentRegistryMutationRejectedError("Requester ownership changed");
      }
      return {
        value: true,
        postimages: new Map([[current.runId, { ...current, label: "local metadata" }]]),
      };
    });
    const mutation = mutateSubagentRuns(["foreign"], plan);
    if (replaceOwner) {
      await expect(mutation).rejects.toBeInstanceOf(SubagentRegistryMutationRejectedError);
    } else {
      await expect(mutation).resolves.toBe(true);
    }
    expect(plan).toHaveBeenCalledTimes(2);
    const saved = loadSubagentRegistryFromSqlite().get("foreign");
    expect(saved?.model).toBe("foreign metadata");
    expect(saved?.label).toBe(replaceOwner ? undefined : "local metadata");
    expect(subagentRuns.get("foreign")?.requesterSessionKey).toBe(saved?.requesterSessionKey);
  },
);

it("bounds repeated foreign conflicts and leaves the latest authoritative row published", async () => {
  await register(entry("contended"));
  let conflicts = 0;
  interceptWrites((phase) => {
    if (phase !== "before") {
      return;
    }
    const foreign = loadSubagentRegistryFromSqlite().get("contended")!;
    foreign.label = `foreign-${++conflicts}`;
    saveSubagentRegistryChangesToSqlite(new Map([[foreign.runId, foreign]]), [foreign.runId]);
  });
  await expect(
    change("contended", (row) => {
      row.cleanupCompletedAt = 5;
    }),
  ).rejects.toMatchObject({ name: "SubagentRegistryConflictError", attempts: 3 });
  expect(conflicts).toBe(3);
  expect(subagentRuns.get("contended")?.label).toBe("foreign-3");
  expect(loadSubagentRegistryFromSqlite().get("contended")?.cleanupCompletedAt).toBeUndefined();
});

it.each(["payload bytes", "indexed field", "removed", "inserted", "undecodable"] as const)(
  "rejects an entire cohort before companion events when one selected row is foreign %s",
  async (conflict) => {
    const kept = entry("cohort-kept");
    const deleted = entry("cohort-deleted");
    const guarded = entry("cohort-guarded");
    await register(kept, deleted, ...(conflict === "inserted" ? [] : [guarded]));
    const { db } = openOpenClawStateDatabase();
    const rows = () => db.prepare("SELECT * FROM subagent_runs ORDER BY run_id").all();
    let foreignRows: ReturnType<typeof rows> = [];
    let injected = false;
    const intercept = interceptWrites((phase) => {
      if (phase !== "before" || injected) {
        return;
      }
      injected = true;
      if (conflict === "inserted" || conflict === "removed") {
        saveSubagentRegistryChangesToSqlite(
          new Map(conflict === "inserted" ? [[guarded.runId, guarded]] : []),
          [guarded.runId],
        );
      } else if (conflict === "indexed field") {
        db.prepare("UPDATE subagent_runs SET created_at = created_at + 1 WHERE run_id = ?").run(
          guarded.runId,
        );
      } else {
        const original = db
          .prepare("SELECT payload_json FROM subagent_runs WHERE run_id = ?")
          .get(guarded.runId);
        db.prepare("UPDATE subagent_runs SET payload_json = ? WHERE run_id = ?").run(
          conflict === "undecodable" ? "{" : `${String(original?.payload_json)} `,
          guarded.runId,
        );
      }
      foreignRows = rows();
    });
    const plan = vi.fn(() => {
      if (injected) {
        throw new SubagentRegistryMutationRejectedError("Cohort changed after planning");
      }
      return {
        value: undefined,
        postimages: new Map<string, SubagentRunRecord | null>([
          [kept.runId, { ...kept, label: "must not be written" }],
          [deleted.runId, null],
        ]),
        terminalEvents: [
          {
            input: {
              event: {
                sessionKey: kept.childSessionKey,
                agentId: "main",
                kind: "run_completed" as const,
                actorType: "agent" as const,
                runId: kept.runId,
                summary: "must not be recorded",
              },
              now: 10,
            },
          },
        ],
      };
    });
    try {
      await expect(
        mutateSubagentRuns([kept.runId, deleted.runId, guarded.runId], plan),
      ).rejects.toBeInstanceOf(SubagentRegistryMutationRejectedError);
      expect(plan).toHaveBeenCalledTimes(conflict === "undecodable" ? 1 : 2);
      expect(rows()).toEqual(foreignRows);
      expect(
        db.prepare("SELECT * FROM session_state_events WHERE run_id = ?").all(kept.runId),
      ).toEqual([]);
    } finally {
      intercept.mockRestore();
      // An undecodable foreign row is intentionally absent from the canonical cleanup reader.
      saveSubagentRegistryChangesToSqlite(new Map(), [guarded.runId]);
    }
  },
);

it("fences an uncertain row through source close until canonical restoration", async () => {
  await register(entry("uncertain"));
  const failure = new SqliteWorkerError("synthetic lost transport outcome", "outcome-unknown");
  const execute = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
  execute.mockRejectedValueOnce(failure);
  await expect(
    change("uncertain", (row) => {
      row.label = "not acknowledged";
    }),
  ).rejects.toMatchObject({ outcome: "unknown" });
  const blocked = vi.fn((row: SubagentRunRecord) => {
    row.label = "must not plan";
  });
  await expect(change("uncertain", blocked)).rejects.toMatchObject({ outcome: "unknown" });
  expect(blocked).not.toHaveBeenCalled();
  execute.mockRestore();
  await closeOpenClawStateDatabaseAsync();
  openOpenClawStateDatabase();
  await expect(change("uncertain", blocked)).rejects.toMatchObject({ outcome: "unknown" });
  expect(blocked).not.toHaveBeenCalled();
  await restoreSubagentRunsFromDisk({ runs: subagentRuns });
  await change("uncertain", (row) => {
    row.label = "after canonical restore";
  });
  expect(loadSubagentRegistryFromSqlite().get("uncertain")?.label).toBe("after canonical restore");
});

it("serializes opposite multi-row orders without a lock-order deadlock", async () => {
  await register(entry("a"), entry("b"));
  const update = (ids: string[], label: string) =>
    mutateSubagentRuns(ids, (rows) => ({
      value: undefined,
      postimages: new Map(
        [...rows].map(([id, row]) => [id, { ...row, label: `${row.label ?? ""}${label}` }]),
      ),
    }));
  await Promise.all([update(["a", "b"], "first"), update(["b", "a"], "/second")]);
  expect([...loadSubagentRegistryFromSqlite().values()].map((row) => row.label)).toEqual([
    "first/second",
    "first/second",
  ]);
});

it("settles a requester cohort while many children finish, wake, and one is killed", async () => {
  const children = Array.from({ length: 18 }, (_, index) => ({
    ...entry(`child-${index}`),
    completion: { required: true },
    delivery: { status: "pending" as const },
    requesterSettleWake: { status: "pending" as const, attemptCount: 0, rearmGeneration: 1 },
  }));
  const stopped = {
    ...entry("killed"),
    collect: true,
    execution: {
      status: "running" as const,
      startedAt: 1,
      suppressSessionEffects: true as const,
    },
  };
  await register(...children, stopped);
  const manager = createSubagentRunManager({
    runs: subagentRuns,
    getRunsForChildSession: (key) =>
      [...subagentRuns.values()].filter((row) => row.childSessionKey === key),
    resumedRuns: new Set(),
    acquireTerminalCompletionLock: async () => () => {},
    callGateway: async () => {
      throw new Error("Stress fixture unexpectedly called the Gateway");
    },
    getRuntimeConfig: () => ({}),
    ensureListener: () => {},
    startSweeper: () => {},
    stopSweeper: () => {},
    resumeSubagentRun: () => {},
    clearPendingLifecycleError: () => {},
    clearPendingLifecycleTimeout: () => {},
    resolveSubagentWaitTimeoutMs: () => 100,
    scheduleSweep: () => {},
    resolveSubagentSessionCompletion: async () => null,
    resolveSubagentSessionStartedAt: async () => undefined,
    notifyContextEngineSubagentEnded: async () => {},
    completeCleanupBookkeeping: async () => {},
    completeSubagentRun: async () => {},
  });
  const context = captureOpenClawStateWorkerContext();
  const completions = children.map((child) =>
    change(child.runId, (row) => {
      row.execution = { status: "terminal", startedAt: 1, endedAt: 2, outcome: { status: "ok" } };
      row.completion = { required: true, capturedAt: 2, resultText: `result ${child.runId}` };
    }),
  );
  const wakes = children.map((child) =>
    mutateRequesterSettleWakeBatch({
      entries: [child],
      context,
      assertCurrent: () => {},
      onCommitted: () => {},
      onPublished: () => {},
      operation: {
        kind: "transition",
        state: { status: "dispatching", attemptCount: 1, rearmGeneration: 1 },
      },
    }),
  );
  const settlement = Promise.all(wakes).then(() =>
    settleRequesterCompletionBatch({
      entries: children.map(({ runId }) => {
        const subagent = subagentRuns.get(runId);
        if (!subagent) {
          throw new Error("Requester wake lost its acknowledged child");
        }
        return { subagent };
      }),
      context,
      outcome: { delivered: true, path: "direct" },
      isCurrent: () => true,
    }),
  );
  const killed = manager.markSubagentRunTerminated({
    runId: stopped.runId,
    reason: "synthetic kill",
    suppressTaskDelivery: true,
  });
  const results = await Promise.allSettled([...completions, ...wakes, settlement, killed]);
  expect(results.filter((result) => result.status === "rejected")).toEqual([]);
  const saved = loadSubagentRegistryFromSqlite();
  expect(saved.size).toBe(children.length + 1);
  for (const child of children) {
    expect(saved.get(child.runId)?.execution.status).toBe("terminal");
    expect(saved.get(child.runId)?.completion?.resultText).toBe(`result ${child.runId}`);
  }
  expect(saved.get(stopped.runId)).toMatchObject({
    execution: { status: "terminal", outcome: { status: "error", error: "synthetic kill" } },
    killReconciliation: { suppressTaskDelivery: true },
    suppressAnnounceReason: "killed",
  });
  expect([...saved.values()].every((row) => row.requesterSettleWake === undefined)).toBe(true);
});

it("installs captured raw postimages and runtime custody before notifying every projection", async () => {
  vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
  await register(entry("changed"), entry("removed"));
  await restoreSubagentRunsFromDisk({ runs: subagentRuns });
  const reached = createDeferredCore();
  const release = createDeferredCore();
  let held = false;
  interceptWrites(async (phase) => {
    if (phase === "after" && !held) {
      held = true;
      reached.resolve();
      await release.promise;
    }
  });
  const events: string[] = [];
  const stop = subscribeSubagentRunChanges("persistence", () => {
    events.push("observer");
    for (const read of [
      getSubagentRunsSnapshotForRead,
      getSubagentMaintenanceRunsSnapshotForRead,
      getSubagentSessionListRunsSnapshotForRead,
    ]) {
      expect(read(new Map()).get("changed")?.execution.status).toBe("terminal");
      expect(read(new Map()).has("removed")).toBe(false);
    }
  });
  const draft = {
    ...entry("changed"),
    label: "captured",
    cleanupHandled: true,
    execution: { status: "terminal" as const, endedAt: 2 },
  };
  const pending = mutateSubagentRuns(
    ["changed", "removed"],
    () => ({
      value: undefined,
      postimages: new Map<string, SubagentRunRecord | null>([
        ["changed", draft],
        ["removed", null],
      ]),
    }),
    {
      onPublished: () => {
        events.push("custody");
      },
    },
  );
  try {
    await awaitGateBeforeSettlement(reached.promise, pending, "publication missed ACK gate");
    draft.label = "uncommitted caller edit";
    expect(events).toEqual([]);
    expect(subagentRuns.has("removed")).toBe(true);
    release.resolve();
    await pending;
    expect(events).toEqual(["custody", "observer"]);
    expect(subagentRuns.get("changed")).toMatchObject({ label: "captured", cleanupHandled: true });
    expect(loadSubagentRegistryFromSqlite().get("changed")?.cleanupHandled).toBe(false);
  } finally {
    release.resolve();
    stop();
    await Promise.allSettled([pending]);
  }
});

it.each(["transaction", "commit"] as const)(
  "revalidates live caller authority at native %s admission",
  async (stage) => {
    await register(entry("guarded"));
    let current = true;
    const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === stage) {
            current = false;
          }
          admit(request, grant);
        }, attachment),
    );
    const mutation = mutateSubagentRuns(
      ["guarded"],
      (rows) => ({
        value: undefined,
        postimages: new Map([["guarded", { ...rows.get("guarded")!, label: "must roll back" }]]),
      }),
      {
        assertCurrent: () => {
          if (!current) {
            throw new Error("Caller retired");
          }
        },
      },
    );
    await expect(mutation).rejects.toMatchObject({ outcome: "not-committed" });
    expect(subagentRuns.get("guarded")?.label).toBeUndefined();
    expect(loadSubagentRegistryFromSqlite().get("guarded")?.label).toBeUndefined();
  },
);

it("keeps an acknowledged row and notifies readers when its custody callback fails", async () => {
  vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
  await register({ ...entry("callback"), execution: { status: "queued" } });
  await restoreSubagentRunsFromDisk({ runs: subagentRuns });
  const readStates = () =>
    [
      getSubagentRunsSnapshotForRead,
      getSubagentMaintenanceRunsSnapshotForRead,
      getSubagentSessionListRunsSnapshotForRead,
    ].map((read) => read(new Map()).get("callback")?.execution.status);
  expect(readStates()).toEqual(["queued", "queued", "queued"]);
  const revision = getSubagentRegistryPublicationRevision();
  let writes = 0;
  interceptWrites((phase) => {
    if (phase === "before") {
      writes += 1;
    }
  });
  const observed = vi.fn(readStates);
  const stop = subscribeSubagentRunChanges("persistence", observed);
  try {
    await expect(
      mutateSubagentRuns(
        ["callback"],
        (rows) => ({
          value: undefined,
          postimages: new Map([
            [
              "callback",
              {
                ...rows.get("callback")!,
                label: "committed",
                execution: { status: "running" as const },
              },
            ],
          ]),
        }),
        {
          onPublished: () => {
            throw new Error("Synthetic custody failure");
          },
        },
      ),
    ).rejects.toMatchObject({ outcome: "committed", publication: "published" });
    expect(observed).toHaveBeenCalledOnce();
    expect(observed).toHaveReturnedWith(["running", "running", "running"]);
    expect(getSubagentRegistryPublicationRevision()).toBe(revision + 1);
    expect(writes).toBe(1);
    expect(subagentRuns.get("callback")?.label).toBe("committed");
    expect(loadSubagentRegistryFromSqlite().get("callback")?.label).toBe("committed");
    await change("callback", (row) => {
      row.cleanupCompletedAt = 3;
    });
  } finally {
    stop();
  }
});

it.each(["before ACK", "inside callback", "inside failing callback"] as const)(
  "keeps an old-source commit from notifying a replacement database (%s)",
  async (transition) => {
    await register(entry("source"));
    const original = captureOpenClawStateWorkerContext();
    const reached = createDeferredCore();
    const release = createDeferredCore();
    const observed = vi.fn();
    const stop = subscribeSubagentRunChanges("persistence", observed);
    const revision = getSubagentRegistryPublicationRevision();
    const replaceSource = () => {
      vi.spyOn(workerContext, "captureOpenClawStateWorkerContext").mockReturnValue({
        ...original,
        admission: {
          ...original.admission,
          identity: { ...original.admission.identity, key: "replacement" },
        },
      });
    };
    interceptWrites(async (phase) => {
      if (phase === "after" && transition === "before ACK") {
        reached.resolve();
        await release.promise;
      }
    });
    const pending = mutateSubagentRuns(
      ["source"],
      (rows) => ({
        value: undefined,
        postimages: new Map([["source", { ...rows.get("source")!, label: "old database commit" }]]),
      }),
      {
        onPublished: () => {
          if (transition !== "before ACK") {
            replaceSource();
            if (transition === "inside failing callback") {
              throw new Error("Synthetic custody failure after source replacement");
            }
          }
        },
      },
    );
    const outcome = pending.catch((error: unknown) => error);
    try {
      if (transition === "before ACK") {
        await awaitGateBeforeSettlement(reached.promise, pending, "write missed its ACK gate");
        replaceSource();
        release.resolve();
      }
      expect(await outcome).toMatchObject({
        outcome: "committed",
        publication: transition === "before ACK" ? "superseded" : "published",
      });
      // Callback retirement cannot undo old-source rows that were already installed.
      expect(subagentRuns.get("source")?.label).toBe(
        transition === "before ACK" ? undefined : "old database commit",
      );
      expect(loadSubagentRegistryFromSqlite().get("source")?.label).toBe("old database commit");
      expect(observed).not.toHaveBeenCalled();
      expect(getSubagentRegistryPublicationRevision()).toBe(revision);
    } finally {
      release.resolve();
      await outcome;
      stop();
    }
  },
);

it("retains prepared announcement authority across bookkeeping and revokes it for a new terminal result", async () => {
  const child = entry("announcement");
  child.execution = {
    status: "terminal",
    endedAt: 2,
    outcome: { status: "ok" },
    transcriptTarget: {
      agentId: "main",
      sessionId: "synthetic-session",
      sessionKey: child.childSessionKey,
      storePath: "/synthetic/sessions",
    },
  };
  child.completion = {
    required: true,
    terminalReply: { disposition: "visible", text: "child result" },
  };
  await register(child);
  const prepared = await readSubagentRunAnnounceResultUsing(subagentRuns.get(child.runId)!, {
    readSubagentRun: (runId) => subagentRuns.get(runId),
    getRuntimeConfig: () => ({}),
    readSubagentSessionEntry: () => undefined,
    resolveAgentIdFromSessionKey: () => "main",
    resolveSessionStorePathCore: () => "/synthetic/sessions",
    findTranscriptEvent: async () => ({
      event: { message: { role: "assistant", content: [{ type: "text", text: "child result" }] } },
    }),
    findSessionTranscriptArchiveEventReadOnly: async () => undefined,
  });
  await change(child.runId, (row) => {
    row.completion!.capturedAt = 2;
  });
  expect(prepared.text).toBe("child result");
  expect(prepared.isCurrent()).toBe(true);
  await change(child.runId, (row) => {
    row.completion!.terminalReply = { disposition: "silent" };
  });
  expect(prepared.isCurrent()).toBe(false);
});

it("retains the execution's Gateway binding through immutable metadata publications", async () => {
  const child = entry("bound");
  child.execution = { status: "terminal", endedAt: 2 };
  child.requesterSettleWake = { status: "pending", attemptCount: 0 };
  const gateway = createGatewayContext();
  let gatewayOpen = true;
  const resolver = () => (gatewayOpen ? gateway : undefined);
  const alias = await mutateSubagentRuns(
    [child.runId],
    () => ({
      value: child,
      postimages: new Map([[child.runId, child]]),
    }),
    {
      onPublished: (postimages) => {
        const published = postimages.get(child.runId);
        if (!published) {
          throw new Error("Bound registration did not publish its row");
        }
        bindGatewayContextResolver(published, resolver);
      },
    },
  );
  const initial = subagentRuns.get(child.runId)!;
  expect(Object.isFrozen(initial)).toBe(true);
  expect(getGatewayContextResolver(initial)).toBe(resolver);
  expect(isSameSubagentRunOwner(initial, alias)).toBe(true);

  await change(child.runId, (row) => {
    row.label = "updated metadata";
  });

  const published = subagentRuns.get(child.runId)!;
  expect(published).not.toBe(initial);
  expect(Object.isFrozen(published)).toBe(true);
  expect(getGatewayContextResolver(published)).toBe(resolver);
  expect(loadSubagentRegistryFromSqlite().get(child.runId)?.label).toBe("updated metadata");
  expect(isSameSubagentRunOwner(published, alias)).toBe(true);

  gatewayOpen = false;
  const replacementGateway = createGatewayContext();
  const replacementResolver = () => replacementGateway;
  await expect(
    recoverSubagentRunGatewayOwner(published, replacementResolver, () => {}),
  ).resolves.toBe(true);
  const recovered = subagentRuns.get(child.runId)!;
  expect(isSameSubagentRunOwner(recovered, alias)).toBe(false);
  expect(getGatewayContextResolver(initial)?.()).toBeUndefined();
  expect(getGatewayContextResolver(recovered)?.()).toBe(replacementGateway);
  expect(() => subagentRuns.runWithCompletionAuthority(alias, () => "stale")).toThrow(
    "runtime owner is no longer active",
  );
  expect(subagentRuns.runWithCompletionAuthority(recovered, () => "recovered")).toBe("recovered");
});
