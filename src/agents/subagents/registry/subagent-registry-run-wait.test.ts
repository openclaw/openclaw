// The wait manager is where "the child stopped" and "I stopped waiting for the
// child" were the same publication. Both still wake the parent; only one may
// claim the run ended.
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import * as persistence from "./subagent-registry-persistence.js";
import { withQueuedRegistrationFixture } from "./subagent-registry-queued-registration.test-support.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

it.each(["live", "closing"] as const)(
  "settles failed completion recovery with a %s state database",
  async (lifecycle) => {
    await withQueuedRegistrationFixture(async (f) => {
      await f.register();
      await f.change((draft) => {
        draft.execution = { status: "terminal", startedAt: 1, endedAt: 2 };
        draft.cleanupHandled = true;
      });
      const original = f.current();
      const before = structuredClone(original);
      const persisted = f.stored();
      expect(persisted).toBeDefined();
      const write = f.holdNextWrite("before");
      const writesBefore = f.writes;
      const recoveryQueued = createDeferred();
      const mutate = persistence.mutateSubagentRuns;
      let recovering = false;
      let predecessor: Promise<void> | undefined;
      const mutation = vi.spyOn(persistence, "mutateSubagentRuns").mockImplementation((...args) => {
        const pending = mutate(...args);
        if (recovering) {
          recoveryQueued.resolve();
        }
        return pending;
      });
      const timing = vi
        .spyOn(f.options, "resolveSubagentSessionStartedAt")
        .mockImplementation(async () => {
          // cleanupHandled is runtime-only; queue recovery behind an actual durable change.
          predecessor = f.change((draft) => {
            draft.label = "queued before recovery";
          });
          await awaitGateBeforeSettlement(write.entered, predecessor, "Predecessor did not write");
          recovering = true;
          throw new Error("synthetic timing read failed");
        });
      const waiting = f.track(f.manager.waitForSubagentCompletion(original.runId, original));
      let closing: Promise<void> | undefined;
      try {
        await awaitGateBeforeSettlement(
          recoveryQueued.promise,
          waiting,
          "Recovery did not reserve its mutation",
        );
        if (lifecycle === "closing") {
          closing = closeOpenClawStateDatabaseAsync();
          expect(() => captureOpenClawStateWorkerContext()).toThrow("read admission is closed");
        }
        write.release();
        await expect(waiting).resolves.toBeUndefined();
        await closing;
        expect(f.writes).toBe(writesBefore + 1);
        if (lifecycle === "live") {
          await predecessor;
          expect(f.current()).toMatchObject({
            cleanupHandled: false,
            label: "queued before recovery",
          });
          expect(f.stored()?.cleanupHandled).toBe(false);
          expect(f.options.resumeSubagentRun).toHaveBeenCalledExactlyOnceWith(original.runId);
        } else {
          expect(f.stored()).toEqual(persisted);
          expect(f.current()).toEqual(before);
          expect(f.options.resumeSubagentRun).not.toHaveBeenCalled();
          expect(f.options.scheduleSweep).not.toHaveBeenCalled();
        }
      } finally {
        write.release();
        await Promise.allSettled([waiting, predecessor, closing]);
        timing.mockRestore();
        mutation.mockRestore();
      }
    });
  },
);

it.each([false, true])(
  "retires a closed wait without hiding an unknown outcome (%s)",
  async (unknown) => {
    await withQueuedRegistrationFixture(async (f) => {
      await f.register();
      const original = f.current();
      const before = structuredClone(original);
      const entered = createDeferred();
      const release = createDeferred();
      const fault = new SqliteWorkerError("synthetic unknown write outcome", "outcome-unknown");
      const timing = vi
        .spyOn(f.options, "resolveSubagentSessionStartedAt")
        .mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          if (unknown) {
            throw fault;
          }
        });
      const waiting = f.track(f.manager.waitForSubagentCompletion(original.runId, original));
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          waiting,
          "Wait did not reach reconciliation",
        );
        await closeOpenClawStateDatabaseAsync();
        release.resolve();
        if (unknown) {
          await expect(waiting).rejects.toBe(fault);
        } else {
          await expect(waiting).resolves.toBeUndefined();
        }
        expect(f.current()).toEqual(before);
        expect(f.options.resumeSubagentRun).not.toHaveBeenCalled();
        expect(f.options.scheduleSweep).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([waiting]);
        timing.mockRestore();
      }
    });
  },
);

const RUN_ID = "run-wait-disposition";
const RUN_TIMEOUT_SECONDS = 3;

type AgentWaitResponse = {
  status: string;
  startedAt?: number;
  endedAt?: number;
  stopReason?: string;
  livenessState?: string;
};

function createRunningEntry(startedAt: number): SubagentRunRecord {
  // Build through the canonical factory, never a hand-rolled literal behind an
  // `as` cast: row versioning binds the nested completion/delivery state, and
  // without it every write dies with "missing canonical nested state" — which
  // the wait manager swallows into its recovery path, so the suite goes quietly
  // vacuous instead of red.
  return createSubagentRunRecord({
    runId: RUN_ID,
    task: "hold a git worktree for a long time",
    createdAt: startedAt,
    runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
    startedAt,
  });
}

function createWaitManager(params: {
  entry: SubagentRunRecord;
  wait: AgentWaitResponse;
  reportSubagentWaitExpiry?: SubagentManagerOptions["reportSubagentWaitExpiry"];
}) {
  const completions: SubagentCompletionRequest[] = [];
  const waitExpiries: Parameters<SubagentManagerOptions["reportSubagentWaitExpiry"]>[0][] = [];
  const runs = new Map([[params.entry.runId, params.entry]]);
  const options = {
    runs,
    getChildSessionCandidates: () => runs.values(),
    getRunsForChildSession: () => runs.values(),
    resumedRuns: new Set<object>(),
    acquireTerminalCompletionLock: async () => () => {},
    callGateway: (async (_opts: CallGatewayOptions) =>
      params.wait) as SubagentManagerOptions["callGateway"],
    getRuntimeConfig: (() => ({})) as SubagentManagerOptions["getRuntimeConfig"],
    ensureListener: vi.fn(),
    startSweeper: vi.fn(),
    stopSweeper: vi.fn(),
    resumeSubagentRun: vi.fn(),
    clearPendingLifecycleError: vi.fn(),
    clearPendingLifecycleTimeout: vi.fn(),
    resolveSubagentWaitTimeoutMs: () => 50,
    scheduleSweep: vi.fn(),
    // No reconciled session completion exists while the child is mid-turn.
    resolveSubagentSessionCompletion: async () => null,
    resolveSubagentSessionStartedAt: async () => params.entry.execution.startedAt,
    notifyContextEngineSubagentEnded: async () => {},
    completeCleanupBookkeeping: vi.fn(),
    completeSubagentRun: async (request: SubagentCompletionRequest) => {
      completions.push(request);
    },
    reportSubagentWaitExpiry:
      params.reportSubagentWaitExpiry ??
      (async (request) => {
        waitExpiries.push(request);
      }),
  } satisfies SubagentManagerOptions;
  return { manager: createSubagentRunManager(options), completions, waitExpiries };
}

describe("subagent run wait disposition", () => {
  it("reports a still-live child when only the stored run deadline expired", async () => {
    // Past the deadline, but agent.wait returned no terminal snapshot at all:
    // no endedAt, no stopReason, no livenessState. That is our clock, not the
    // child's ending — the exact shape observed on the 90-minute false death.
    const entry = createRunningEntry(Date.now() - (RUN_TIMEOUT_SECONDS + 1) * 1_000);
    const { manager, completions, waitExpiries } = createWaitManager({
      entry,
      wait: { status: "timeout" },
    });

    await manager.waitForSubagentCompletion(RUN_ID, entry, 50);

    expect(completions).toHaveLength(0);
    expect(waitExpiries).toHaveLength(1);
    expect(waitExpiries[0]).toMatchObject({ entry, startedAt: entry.execution.startedAt });
    expect(entry.execution).toEqual({ status: "running", startedAt: entry.execution.startedAt });
    expect(entry.cleanupHandled).toBeUndefined();
    expect(entry.cleanupCompletedAt).toBeUndefined();
  });

  it("reports an exited child when the wait carried a terminal snapshot", async () => {
    const startedAt = Date.now() - 1_000;
    const entry = createRunningEntry(startedAt);
    const { manager, completions } = createWaitManager({
      entry,
      wait: { status: "timeout", endedAt: startedAt + 500 },
    });

    await manager.waitForSubagentCompletion(RUN_ID, entry, 50);

    expect(completions).toHaveLength(1);
    expect(completions[0]?.outcome).toEqual({ status: "timeout", disposition: "exited" });
  });

  // Each case carries the wait status that stop reason actually presents. An
  // `rpc` stop is only a cancellation when the wait itself is not ok, because a
  // model/ACP "stop" on a successful wait is an ordinary completion; `aborted`
  // and `superseded` are cancellations on their reason alone.
  it.each([
    { stopReason: "rpc", status: "error" },
    { stopReason: "aborted", status: "ok" },
    { stopReason: "superseded", status: "ok" },
  ] as const)(
    "retains killed disposition from a $stopReason cancellation snapshot",
    async ({ stopReason, status }) => {
      const startedAt = Date.now() - 1_000;
      const entry = createRunningEntry(startedAt);
      const { manager, completions, waitExpiries } = createWaitManager({
        entry,
        wait: { status, startedAt, endedAt: startedAt + 500, stopReason },
      });

      await manager.waitForSubagentCompletion(RUN_ID, entry, 50);

      expect(waitExpiries).toHaveLength(0);
      expect(completions).toHaveLength(1);
      expect(completions[0]).toMatchObject({
        reason: "subagent-killed",
        outcome: {
          status: "error",
          disposition: "killed",
          error: "subagent run terminated",
          startedAt,
          endedAt: startedAt + 500,
          elapsedMs: 500,
        },
      });
    },
  );

  // The same cancellation snapshots, but observed after the stored deadline.
  // `completeWithDeadline` clamps the reported end back to the deadline and
  // settles through `completeAsRunTimeout`, which never reaches the killed
  // branch in the fallback below it — so the publication read `exited` for a
  // child that was cancelled, which is the disposition a parent uses to decide
  // whether a successor may take the child's workspace.
  it.each([
    { stopReason: "rpc", status: "error" },
    { stopReason: "aborted", status: "ok" },
    { stopReason: "superseded", status: "ok" },
  ] as const)(
    "retains killed disposition when a $stopReason cancellation lands past the stored deadline",
    async ({ stopReason, status }) => {
      const startedAt = Date.now() - (RUN_TIMEOUT_SECONDS + 3) * 1_000;
      const deadlineAt = startedAt + RUN_TIMEOUT_SECONDS * 1_000;
      const entry = createRunningEntry(startedAt);
      const { manager, completions, waitExpiries } = createWaitManager({
        entry,
        wait: { status, startedAt, endedAt: deadlineAt + 1_000, stopReason },
      });

      await manager.waitForSubagentCompletion(RUN_ID, entry, 50);

      expect(waitExpiries).toHaveLength(0);
      expect(completions).toHaveLength(1);
      // The clamp keeps the intended timeout framing — the reported end is the
      // deadline and the status is `timeout`. Only who stopped the run changes.
      expect(completions[0]).toMatchObject({
        endedAt: deadlineAt,
        reason: "subagent-complete",
        outcome: { status: "timeout", disposition: "killed" },
      });
    },
  );

  // A re-arm counted on a mocked reporter proved nothing durable. The
  // settlement regression that observes a committed row after an injected
  // marker-write failure lives with the real registry owner, in
  // `subagent-registry.test.ts`.
  it("reuses the recorded observation timestamp when the child starts before a retry", async () => {
    // The queued child had no start time when the first observation was
    // recorded, so the deadline was `createdAt + timeout`. Once it starts, the
    // deadline moves — and the reporter refuses any timestamp but the one it
    // recorded, which silently discarded the pending notification.
    const createdAt = Date.now() - (RUN_TIMEOUT_SECONDS + 1) * 1_000;
    const entry = createRunningEntry(createdAt);
    const recordedObservedAt = createdAt + RUN_TIMEOUT_SECONDS * 1_000;
    entry.waitExpiryObservedAt = recordedObservedAt;
    entry.execution = { status: "running", startedAt: createdAt + 500 };
    const { manager, waitExpiries } = createWaitManager({
      entry,
      wait: { status: "timeout" },
    });

    await manager.waitForSubagentCompletion(RUN_ID, entry, 50);

    expect(waitExpiries).toHaveLength(1);
    expect(waitExpiries[0]?.observedAt).toBe(recordedObservedAt);
  });

  it("reports an exited child when a stop reason proves the run settled", async () => {
    const entry = createRunningEntry(Date.now() - (RUN_TIMEOUT_SECONDS + 1) * 1_000);
    const { manager, completions } = createWaitManager({
      entry,
      wait: { status: "timeout", stopReason: "timeout" },
    });

    await manager.waitForSubagentCompletion(RUN_ID, entry, 50);

    expect(completions[0]?.outcome).toMatchObject({ disposition: "exited" });
  });
});
