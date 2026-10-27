import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../../test/helpers/sqlite-parent-observer.js";
import { createContext as createGatewayContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import * as snapshotSource from "../../../infra/sqlite-snapshot-source.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import * as operationAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-context-binding.js";
import * as sessionStateNotices from "../../../sessions/session-state-notices.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { clearOpenClawDatabaseQuarantine } from "../../../state/openclaw-quarantine-store.js";
import { seedOpenClawDatabaseQuarantine } from "../../../state/openclaw-quarantine-store.test-support.js";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { mutateRequesterCompletionBatch } from "../completion/subagent-completion-admission.store.js";
import { bindSubagentRunGatewayOwners } from "./subagent-registry-gateway-owner.js";
import { getSubagentActivationRuns, subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import {
  getSubagentRegistryPublicationRevision,
  subscribeSubagentRunChanges,
} from "./subagent-registry-publication.js";
import { createSubagentManagerTestOptions } from "./subagent-registry-queued-recovery.test-support.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryChangesToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import {
  getSubagentRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForRead,
  prepareSubagentRegistrationRows,
} from "./subagent-registry-state.js";
import {
  change,
  entry,
  postimages,
  register,
  restore,
  stored,
  useSubagentRegistryWorkerFixture,
} from "./subagent-registry-worker.test-support.js";
import { streamSubagentRegistryInWorker } from "./subagent-registry.store.restore.worker.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

const fixture = useSubagentRegistryWorkerFixture();
const projections = [getSubagentRunsSnapshotForRead, getSubagentSessionListRunsSnapshotForRead];

function seed(...rows: SubagentRunRecord[]) {
  saveSubagentRegistryChangesToSqlite(
    new Map(rows.map((row) => [row.runId, row])),
    rows.map((row) => row.runId),
  );
}
function interceptChunks(
  onChunk: (value: unknown, forward: () => void) => void,
  signal?: AbortSignal,
) {
  const read = stateReads.executeExistingOpenClawStateRead;
  return vi
    .spyOn(stateReads, "executeExistingOpenClawStateRead")
    .mockImplementation((options, command, readOptions) =>
      read(options, command, {
        ...readOptions,
        ...(signal ? { signal } : {}),
        onChunkAsync: undefined,
        onChunk(value) {
          onChunk(value, () => readOptions?.onChunk?.(value));
        },
      }),
    );
}

it("restores rows without an explicit read transaction", async () => {
  seed(entry("autocommit-restore"));
  const databasePath = openOpenClawStateDatabase().path;
  const context = captureOpenClawStateWorkerContext();
  const execute = vi.spyOn(DatabaseSync.prototype, "exec");
  const request = vi.fn(async () => ({ input: undefined, consumed: () => {} }));
  const count = await streamSubagentRegistryInWorker(
    {
      context,
      databasePath,
      location: databasePath,
      checkFreshAdmission: true,
      command: { type: "subagents.restore" },
    },
    { consumeInput: () => {}, notify: () => {}, request },
    () => {},
  );
  expect(count).toBe(1);
  expect(request).toHaveBeenCalledWith([
    expect.objectContaining({ entry: expect.objectContaining({ runId: "autocommit-restore" }) }),
  ]);
  expect(
    execute.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)\b/iu.test(sql)),
  ).toEqual([]);
});

it("streams bounded restore batches in one read and retains one snapshot", async () => {
  const entries = [3, 1, 2].map((createdAt, index) =>
    entry(`paged-${index}`, {
      createdAt,
      task: "synthetic retained task ".repeat(24_000),
    }),
  );
  seed(...entries);
  const payloadBytes: number[] = [];
  const observe = interceptChunks((value, forward) => {
    payloadBytes.push(Buffer.byteLength(JSON.stringify(value)));
    forward();
    if (payloadBytes.length === 1) {
      seed({ ...entries[2]!, model: "foreign metadata" }, entry("added-after-snapshot"));
    }
  });
  try {
    await restore();
    expect(observe).toHaveBeenCalledOnce();
    expect(payloadBytes.length).toBeGreaterThan(1);
    expect(Math.max(...payloadBytes)).toBeLessThanOrEqual(1024 * 1024);
    expect([...subagentRuns.keys()]).toEqual(["paged-1", "paged-2", "paged-0"]);
    expect(subagentRuns.get("paged-2")).toMatchObject({ task: entries[2]!.task });
    expect(subagentRuns.get("paged-2")?.model).toBeUndefined();
  } finally {
    observe.mockRestore();
  }
  await mutateSubagentRuns(["paged-0"], (rows) =>
    postimages([["paged-0", { ...rows.get("paged-0")!, label: "restored metadata" }]]),
  );
  await restore();
  await change("paged-2", { label: "after snapshot" });
  expect(stored("paged-2")).toMatchObject({
    model: "foreign metadata",
    label: "after snapshot",
  });
});

it("joins a cancelled stream without publishing partial restored rows", async () => {
  const entries = Array.from({ length: 129 }, (_, index) => entry(`cancelled-${index}`));
  seed(...entries);
  const revision = getSubagentRegistryPublicationRevision();
  const controller = new AbortController();
  const failure = new Error("Synthetic restore cancellation");
  const observe = interceptChunks((_value, forward) => {
    forward();
    controller.abort(failure);
  }, controller.signal);
  await expect(restore()).rejects.toThrow(failure.message);
  expect(subagentRuns.size).toBe(0);
  expect(getSubagentRegistryPublicationRevision()).toBe(revision);
  observe.mockRestore();
  await restore();
  expect(subagentRuns.size).toBe(entries.length);
});

it("refuses quarantined registry reads in the worker without replacing resident publication", async () => {
  const durable = entry("quarantined-durable");
  seed(durable);
  const pathname = openOpenClawStateDatabase().path;
  await closeOpenClawStateDatabaseAsync();
  const resident = entry("retained-resident");
  subagentRuns.set(resident.runId, resident);
  const revision = getSubagentRegistryPublicationRevision();
  const reason = "synthetic registry quarantine";
  seedOpenClawDatabaseQuarantine({ env: fixture.state.env, kind: "state", path: pathname, reason });
  const staging = vi.spyOn(snapshotSource, "startSqliteReadOnlyLocationAsync");
  const hostSql = observeParentSqlite();
  try {
    await expect(restore()).rejects.toThrow(reason);
    expect([...subagentRuns.keys()]).toEqual([resident.runId]);
    expect(subagentRuns.get(resident.runId)).toBe(resident);
    expect(getSubagentRegistryPublicationRevision()).toBe(revision);
    expect(staging).not.toHaveBeenCalled();
    expect(hostSql.counts).toEqual(emptySqliteCounts());
  } finally {
    hostSql.restore();
    staging.mockRestore();
    clearOpenClawDatabaseQuarantine(pathname, { env: fixture.state.env });
    await closeOpenClawStateDatabaseAsync();
  }
});

function interceptWrites(callback: (phase: "before" | "after") => void | Promise<void>) {
  return probe.command(stateWorker, async (command, executeOptions, scope) => {
    if (command.type === "subagents.persistChanges") {
      await callback("before");
    }
    const receipt = await scope.execute(command, executeOptions);
    if (command.type === "subagents.persistChanges") {
      await callback("after");
    }
    return receipt;
  });
}

function holdFirstAck(onWrite = () => {}) {
  const reached = createDeferredCore();
  const release = createDeferredCore();
  let held = false;
  interceptWrites(async (phase) => {
    if (phase === "before") {
      onWrite();
    }
    if (phase === "after" && !held) {
      held = true;
      reached.resolve();
      await release.promise;
    }
  });
  return { reached, release };
}

it.each(["delivered", "lost"] as const)(
  "publishes native registry receipts once without repeating their payload in the reply (%s)",
  async (delivery) => {
    const original = entry(`native-receipt-${delivery}`);
    await register(original);
    const replies: unknown[] = [];
    probe.command(stateWorker, async (command, executeOptions, scope) => {
      const reply = await scope.execute(command, executeOptions);
      if (command.type === "subagents.persistChanges") {
        replies.push(reply);
        if (delivery === "lost") {
          throw new SqliteWorkerError("Synthetic lost registry ACK", "outcome-unknown");
        }
      }
      return reply;
    });
    const notify = vi
      .spyOn(sessionStateNotices, "enqueueSessionStateNotice")
      .mockImplementation(() => {});
    const published = vi.fn();
    const stop = subscribeSubagentRunChanges("persistence", published);
    const onPublished = vi.fn();
    try {
      const value = await mutateSubagentRuns(
        [original.runId],
        (rows) => ({
          value: "updated",
          postimages: new Map([
            [original.runId, { ...rows.get(original.runId)!, label: "native receipt" }],
          ]),
          terminalEvents: [
            {
              input: {
                event: {
                  sessionKey: original.childSessionKey,
                  agentId: "main",
                  kind: "goal_changed",
                  actorType: "system",
                  summary: "Synthetic registry receipt notice",
                  watcherSessionKeys: [original.requesterSessionKey],
                },
                now: Date.now(),
              },
            },
          ],
        }),
        { onPublished },
      );
      expect(value).toBe("updated");
      expect(subagentRuns.get(original.runId)?.label).toBe("native receipt");
      expect(stored(original.runId)?.label).toBe("native receipt");
      expect(published).toHaveBeenCalledOnce();
      expect(onPublished).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledExactlyOnceWith({
        watcherSessionKey: original.requesterSessionKey,
        watcherStorePath: null,
        targetSessionKey: original.childSessionKey,
        lastSeenSequence: 0,
        queueOnly: false,
      });
      expect(replies).toEqual([undefined]);
    } finally {
      stop();
    }
  },
);

it.each(["after acknowledgment", "lost acknowledgment", "missing receipt"] as const)(
  "preserves the registry commit outcome and failure with %s",
  async (fault) => {
    const original = entry(`settlement-${fault}`);
    await register(original);
    const failure =
      fault === "lost acknowledgment"
        ? new SqliteWorkerError("Synthetic registry settlement failure", "outcome-unknown")
        : new Error("Synthetic registry settlement failure");
    const run = stateWorker.runOpenClawStateWorkerOperation;
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementationOnce(
      (context, operation, options) => {
        let admission: operationAdmission.SqliteWorkerOperationAdmission | undefined;
        const loseReceipt = () => {
          expect(admission?.committed).toBeDefined();
          Object.defineProperty(admission, "committed", { value: undefined });
        };
        return run(
          context,
          async (scope) => {
            const value = await operation({
              execute: async (command, executeOptions) => {
                const result = await scope.execute(command, executeOptions);
                if (
                  command.type === "subagents.persistChanges" &&
                  fault !== "after acknowledgment"
                ) {
                  loseReceipt();
                  if (fault === "lost acknowledgment") {
                    throw failure;
                  }
                }
                return result;
              },
            });
            if (fault === "after acknowledgment") {
              loseReceipt();
              throw failure;
            }
            return value;
          },
          {
            ...options,
            createAdmission: (nativeOperation) => {
              const prepared = options!.createAdmission!(nativeOperation);
              admission = prepared.admission;
              return prepared;
            },
          },
        );
      },
    );
    const outcome = await change(original.runId, { label: "durably updated" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(stored(original.runId)?.label).toBe("durably updated");
    expect(subagentRuns.get(original.runId)?.label).toBe(original.label);
    expect(outcome).toMatchObject({
      outcome: fault === "after acknowledgment" ? "committed" : "unknown",
      cause:
        fault === "missing receipt"
          ? expect.objectContaining({ message: "Registry committed receipt is unavailable" })
          : failure,
    });
  },
);

it("publishes overlapping durable and runtime-only mutations in FIFO order", async () => {
  await register({ ...entry("overlap"), cleanupHandled: false });
  const context = captureOpenClawStateWorkerContext();
  const registrationRows = await prepareSubagentRegistrationRows(
    "agent:main:subagent:overlap",
    [],
    context,
  );
  let writes = 0;
  const { reached, release } = holdFirstAck(() => {
    writes++;
  });
  const first = change("overlap", { label: "first mutation" });
  let second: Promise<void> | undefined;
  let third: Promise<void> | undefined;
  try {
    await awaitGateBeforeSettlement(
      reached.promise,
      first,
      "first commit did not reach its ACK gate",
    );
    expect(subagentRuns.get("overlap")?.label).toBeUndefined();
    const successorPlan = vi.fn((row: SubagentRunRecord) => {
      row.cleanupHandled = true;
    });
    second = change("overlap", successorPlan);
    third = change("overlap", (row) => {
      expect(row).toMatchObject({ label: "first mutation", cleanupHandled: true });
      expect(registrationRows().get("overlap")?.cleanupHandled).toBe(true);
      row.label = "last mutation";
    });
    expect(successorPlan).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([first, second, third]);
    expect(writes).toBe(2);
    for (const [row, cleanupHandled] of [
      [subagentRuns.get("overlap"), true],
      [stored("overlap"), false],
      [registrationRows().get("overlap"), true],
    ] as const) {
      expect(row).toMatchObject({ label: "last mutation", cleanupHandled });
    }
    expect(() => {
      subagentRuns.get("overlap")!.label = "uncommitted mutation";
    }).toThrow(TypeError);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second, third]);
  }
});

it("rejects a runtime-only mutation when its Gateway recovery owner changes", async () => {
  await register(
    entry("recovery-noop", {
      cleanupHandled: false,
      execution: { status: "terminal", endedAt: 2 },
      requesterSettleWake: { status: "pending", attemptCount: 0 },
    }),
  );
  const expected = subagentRuns.get("recovery-noop")!;
  const previousResolver = () => undefined;
  bindGatewayContextResolver(expected, previousResolver);
  const gateway = createGatewayContext();
  let gatewayCurrent = true;
  const resolver = () => (gatewayCurrent ? gateway : undefined);
  const onPublished = vi.fn();

  await expect(
    mutateSubagentRuns(
      [expected.runId],
      (rows) => {
        gatewayCurrent = false;
        return postimages([
          [expected.runId, { ...rows.get(expected.runId)!, cleanupHandled: true }],
        ]);
      },
      {
        gatewayRecovery: { expected, previousResolver, resolver, gateway },
        onPublished,
      },
    ),
  ).rejects.toThrow("Subagent Gateway recovery owner changed");
  expect(subagentRuns.get(expected.runId)).toBe(expected);
  expect(expected.cleanupHandled).toBe(false);
  expect(onPublished).not.toHaveBeenCalled();
});

it("persists prepared-only registration without resurrecting it after a queued deletion", async () => {
  await register(entry("warm-registration"));
  const original = entry("prepared-deletion");
  await mutateSubagentRuns([original.runId], (rows) => ({ value: undefined, postimages: rows }), {
    preparedRows: () => new Map([[original.runId, original]]),
  });
  expect(subagentRuns.has(original.runId)).toBe(true);
  expect(loadSubagentRegistryFromSqlite().has(original.runId)).toBe(true);
  const preparedRows = await prepareSubagentRegistrationRows(
    original.childSessionKey,
    [original.runId],
    captureOpenClawStateWorkerContext(),
  );
  const { reached, release } = holdFirstAck();
  const deletion = mutateSubagentRuns([original.runId], () => postimages([[original.runId, null]]));
  let successor: Promise<boolean> | undefined;
  try {
    await awaitGateBeforeSettlement(reached.promise, deletion, "delete did not reach its ACK gate");
    successor = mutateSubagentRuns(
      [original.runId],
      (rows) => {
        const previous = rows.get(original.runId);
        return {
          value: Boolean(previous),
          ...(previous ? { postimages: new Map([[original.runId, previous]]) } : {}),
        };
      },
      { preparedRows },
    );
    release.resolve();
    await deletion;
    await expect(successor).resolves.toBe(false);
    expect(subagentRuns.has(original.runId)).toBe(false);
    expect(loadSubagentRegistryFromSqlite().has(original.runId)).toBe(false);
  } finally {
    release.resolve();
    await Promise.allSettled([deletion, successor]);
  }
});

it("fences an uncertain row through source close until canonical restoration", async () => {
  await register(entry("uncertain"));
  const failure = new SqliteWorkerError("synthetic lost transport outcome", "outcome-unknown");
  const execute = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
  execute.mockRejectedValueOnce(failure);
  await expect(change("uncertain", { label: "not acknowledged" })).rejects.toMatchObject({
    outcome: "unknown",
  });
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
  await restore();
  await change("uncertain", { label: "after canonical restore" });
  expect(stored("uncertain")?.label).toBe("after canonical restore");
});

it("serializes opposite multi-row orders without a lock-order deadlock", async () => {
  await register(entry("a"), entry("b"));
  const update = (ids: string[], label: string) =>
    mutateSubagentRuns(ids, (rows) =>
      postimages(
        [...rows].map(([id, row]) => [id, { ...row, label: `${row.label ?? ""}${label}` }]),
      ),
    );
  await Promise.all([update(["a", "b"], "first"), update(["b", "a"], "/second")]);
  expect([...loadSubagentRegistryFromSqlite().values()].map((row) => row.label)).toEqual([
    "first/second",
    "first/second",
  ]);
});

it("settles a requester cohort while many children finish and one is killed", async () => {
  const children = Array.from({ length: 18 }, (_, index) =>
    entry(`child-${index}`, {
      completion: { required: true },
      delivery: { status: "pending" as const },
      requesterSettleWake: { status: "pending" as const, attemptCount: 0, rearmGeneration: 1 },
    }),
  );
  const stopped = entry("killed", {
    childSessionIdentity: { sessionId: "killed-session" },
    collect: true,
    execution: {
      status: "running" as const,
      startedAt: 1,
      suppressSessionEffects: true as const,
    },
  });
  await register(...children, stopped);
  const manager = createSubagentRunManager(
    createSubagentManagerTestOptions(subagentRuns, async () => {
      throw new Error("Stress fixture unexpectedly called the Gateway");
    }),
  );
  const context = captureOpenClawStateWorkerContext();
  const completions = children.map((child) =>
    change(child.runId, (row) => {
      row.execution = { status: "terminal", startedAt: 1, endedAt: 2, outcome: { status: "ok" } };
      row.completion = { required: true, capturedAt: 2, resultText: `result ${child.runId}` };
    }),
  );
  const wakes = children.map((child) =>
    mutateRequesterCompletionBatch({
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
    mutateRequesterCompletionBatch({
      entries: children.map(({ runId }) => {
        const subagent = subagentRuns.get(runId);
        if (!subagent) {
          throw new Error("Requester wake lost its acknowledged child");
        }
        return subagent;
      }),
      context,
      operation: { kind: "settle", outcome: { delivered: true, path: "direct" } },
      assertCurrent: () => {},
    }),
  );
  const killed = manager.markSubagentRunTerminated({
    runId: stopped.runId,
    reason: "synthetic kill",
    suppressTaskDelivery: true,
  });
  const results = await Promise.allSettled([...completions, settlement, killed]);
  expect(results.filter((result) => result.status === "rejected")).toEqual([]);
  const saved = loadSubagentRegistryFromSqlite();
  expect(saved.size).toBe(children.length + 1);
  for (const child of children) {
    expect(saved.get(child.runId)).toMatchObject({
      execution: { status: "terminal" },
      completion: { resultText: `result ${child.runId}` },
    });
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
  await restore();
  const { reached, release } = holdFirstAck();
  const events: string[] = [];
  const stop = subscribeSubagentRunChanges("persistence", () => {
    events.push("observer");
    for (const read of projections) {
      expect(read(new Map()).get("changed")?.execution.status).toBe("terminal");
      expect(read(new Map()).has("removed")).toBe(false);
    }
  });
  const draft = entry("changed", {
    label: "captured",
    cleanupHandled: true,
    execution: { status: "terminal" as const, endedAt: 2 },
  });
  const pending = mutateSubagentRuns(
    ["changed", "removed"],
    () =>
      postimages([
        ["changed", draft],
        ["removed", null],
      ]),
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
    expect(stored("changed")?.cleanupHandled).toBe(false);
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
    probe.admission(operationAdmission, (request, grant, admit) => {
      if (request.stage === stage) {
        current = false;
      }
      admit(request, grant);
    });
    const mutation = change(
      "guarded",
      { label: "must roll back" },
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
    expect(stored("guarded")?.label).toBeUndefined();
  },
);

it("keeps an acknowledged row and notifies readers when its custody callback fails", async () => {
  vi.stubEnv("OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE", "1");
  await register({ ...entry("callback"), execution: { status: "queued" } });
  await restore();
  const readStates = () =>
    projections.map((read) => read(new Map()).get("callback")?.execution.status);
  expect(readStates()).toEqual(["queued", "queued"]);
  const revision = getSubagentRegistryPublicationRevision();
  const observed = vi.fn(readStates);
  const stop = subscribeSubagentRunChanges("persistence", observed);
  try {
    await expect(
      change(
        "callback",
        { label: "committed", execution: { status: "running" } },
        {
          onPublished: () => {
            throw new Error("Synthetic custody failure");
          },
        },
      ),
    ).rejects.toMatchObject({ outcome: "committed", publication: "published" });
    expect(observed).toHaveBeenCalledOnce();
    expect(observed).toHaveReturnedWith(["running", "running"]);
    expect(getSubagentRegistryPublicationRevision()).toBe(revision + 1);
    expect(subagentRuns.get("callback")?.label).toBe("committed");
    expect(stored("callback")?.label).toBe("committed");
    await change("callback", { cleanupCompletedAt: 3 });
  } finally {
    stop();
  }
});

it.each(["before ACK", "inside failing callback"] as const)(
  "keeps an old-source commit from notifying a replacement database (%s)",
  async (transition) => {
    await register(entry("source"));
    const reached = createDeferredCore();
    const release = createDeferredCore();
    const observed = vi.fn();
    const stop = subscribeSubagentRunChanges("persistence", observed);
    const revision = getSubagentRegistryPublicationRevision();
    const replaceSource = () => {
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixture.state.stateDir, "replacement"));
    };
    interceptWrites(async (phase) => {
      if (phase === "after" && transition === "before ACK") {
        reached.resolve();
        await release.promise;
      }
    });
    const pending = change(
      "source",
      { label: "old database commit" },
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
      vi.unstubAllEnvs();
      // Callback retirement cannot undo old-source rows that were already installed.
      expect(subagentRuns.get("source")?.label).toBe(
        transition === "before ACK" ? undefined : "old database commit",
      );
      expect(stored("source")?.label).toBe("old database commit");
      expect(observed).not.toHaveBeenCalled();
      expect(getSubagentRegistryPublicationRevision()).toBe(revision);
    } finally {
      release.resolve();
      await outcome;
      stop();
    }
  },
);

it("retains the execution's Gateway binding through immutable metadata publications", async () => {
  const child = entry("bound");
  child.execution = { status: "terminal", endedAt: 2 };
  child.requesterSettleWake = { status: "pending", attemptCount: 0 };
  const gateway = createGatewayContext();
  let gatewayOpen = true;
  const resolver = () => (gatewayOpen ? gateway : undefined);
  const alias = await mutateSubagentRuns(
    [child.runId],
    () => ({ ...postimages([[child.runId, child]]), value: child }),
    {
      onPublished: (rows) => {
        const published = rows.get(child.runId);
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

  await change(child.runId, { label: "updated metadata" });

  const published = subagentRuns.get(child.runId)!;
  expect(published).not.toBe(initial);
  expect(Object.isFrozen(published)).toBe(true);
  expect(getGatewayContextResolver(published)).toBe(resolver);
  expect(stored(child.runId)?.label).toBe("updated metadata");
  expect(isSameSubagentRunOwner(published, alias)).toBe(true);

  gatewayOpen = false;
  const replacementGateway = createGatewayContext();
  const replacementResolver = () => replacementGateway;
  await expect(
    bindSubagentRunGatewayOwners({
      runs: subagentRuns,
      entries: [...getSubagentActivationRuns(subagentRuns)],
      resumedRuns: new Set(),
      getGatewayContextResolver: () => replacementResolver,
      onRecovered: () => {},
    }),
  ).resolves.toBe(true);
  const recovered = subagentRuns.get(child.runId)!;
  expect(isSameSubagentRunOwner(recovered, alias)).toBe(false);
  expect(getGatewayContextResolver(initial)?.()).toBeUndefined();
  expect(getGatewayContextResolver(recovered)?.()).toBe(replacementGateway);
  expect(() => subagentRuns.runWithCompletionAuthority(alias, () => "stale")).toThrow(
    "runtime owner is no longer active",
  );
  // Gateway ownership alone cannot authorize a continuation without its operator source.
  const dispatch = vi.fn();
  expect(() => subagentRuns.runWithCompletionAuthority(recovered, dispatch)).toThrow(
    "Subagent completion authority is no longer active",
  );
  expect(dispatch).not.toHaveBeenCalled();
});
