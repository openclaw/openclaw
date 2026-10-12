// The wait manager is where "the child stopped" and "I stopped waiting for the
// child" were the same publication. Both still wake the parent; only one may
// claim the run ended.
import { describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

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
