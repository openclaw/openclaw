// The wait manager is where "the child stopped" and "I stopped waiting for the
// child" were the same publication. Both still wake the parent; only one may
// claim the run ended.
import { describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import { type SubagentManagerOptions, SubagentWaitManager } from "./subagent-registry-run-wait.js";
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
  return {
    runId: RUN_ID,
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "hold a git worktree for a long time",
    cleanup: "keep",
    createdAt: startedAt,
    runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
    execution: { status: "running", startedAt },
  } as SubagentRunRecord;
}

function createWaitManager(params: {
  entry: SubagentRunRecord;
  wait: AgentWaitResponse;
  /** Responses for waits after the first; the last one repeats once exhausted. */
  laterWaits?: AgentWaitResponse[];
  reportSubagentWaitExpiry?: SubagentManagerOptions["reportSubagentWaitExpiry"];
  resolveSubagentSessionStartedAt?: SubagentManagerOptions["resolveSubagentSessionStartedAt"];
}) {
  const completions: SubagentCompletionRequest[] = [];
  const waitExpiries: Parameters<SubagentManagerOptions["reportSubagentWaitExpiry"]>[0][] = [];
  const runs = new Map([[params.entry.runId, params.entry]]);
  const laterWaits = [...(params.laterWaits ?? [])];
  let waitCalls = 0;
  const options = {
    runs,
    getRunsForChildSession: () => runs.values(),
    resumedRuns: new Set<string>(),
    persist: vi.fn(),
    persistOrThrow: vi.fn(),
    persistAsyncOrThrow: async (_context, publication) => {
      publication.assertCurrent();
      await Promise.resolve();
      publication.onCommitted?.();
    },
    callGateway: (async (_opts: CallGatewayOptions) => {
      waitCalls += 1;
      if (waitCalls === 1 || laterWaits.length === 0) {
        return waitCalls === 1 ? params.wait : (laterWaits.at(-1) ?? params.wait);
      }
      return laterWaits.length > 1 ? laterWaits.shift() : laterWaits[0];
    }) as SubagentManagerOptions["callGateway"],
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
    resolveSubagentSessionCompletion: () => null,
    resolveSubagentSessionStartedAt:
      params.resolveSubagentSessionStartedAt ?? (() => params.entry.execution.startedAt),
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
    resolveSubagentTask: () => ({ lookup: "available" as const, task: undefined }),
  } satisfies SubagentManagerOptions;
  return { manager: new SubagentWaitManager(options), completions, waitExpiries };
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

    await manager.waitForSubagentCompletion(RUN_ID, 50, entry);

    expect(completions).toHaveLength(0);
    expect(waitExpiries).toHaveLength(1);
    expect(waitExpiries[0]).toMatchObject({ entry, startedAt: entry.execution.startedAt });
    expect(entry.execution).toEqual({ status: "running", startedAt: entry.execution.startedAt });
    expect(entry.cleanupHandled).toBeUndefined();
    expect(entry.cleanupCompletedAt).toBeUndefined();
  });

  it("preserves a successful wait result after a prior nonterminal expiry", async () => {
    const startedAt = Date.now() - 5_000;
    const endedAt = startedAt + 4_000;
    const entry = createRunningEntry(startedAt);
    entry.waitExpiryObservedAt = startedAt + RUN_TIMEOUT_SECONDS * 1_000;
    const { manager, completions } = createWaitManager({
      entry,
      wait: { status: "ok", startedAt, endedAt },
    });

    await manager.waitForSubagentCompletion(RUN_ID, 50, entry);

    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ endedAt, outcome: { status: "ok" } });
  });

  it("reports an exited child when the wait carried a terminal snapshot", async () => {
    const startedAt = Date.now() - 1_000;
    const entry = createRunningEntry(startedAt);
    const { manager, completions } = createWaitManager({
      entry,
      wait: { status: "timeout", endedAt: startedAt + 500 },
    });

    await manager.waitForSubagentCompletion(RUN_ID, 50, entry);

    expect(completions).toHaveLength(1);
    expect(completions[0]?.outcome).toEqual({ status: "timeout", disposition: "exited" });
  });

  it("re-arms the wait after a transient provisional-expiry publication failure", async () => {
    const entry = createRunningEntry(Date.now() - (RUN_TIMEOUT_SECONDS + 1) * 1_000);
    let attempts = 0;
    const reportSubagentWaitExpiry = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient publication failure");
      }
    });
    const { manager } = createWaitManager({
      entry,
      wait: { status: "timeout" },
      reportSubagentWaitExpiry,
    });

    await manager.waitForSubagentCompletion(RUN_ID, 50, entry);
    await expect.poll(() => reportSubagentWaitExpiry.mock.calls.length).toBe(2);
  });

  it("keeps the persisted observation identity when a child starts between publication attempts", async () => {
    // The first wait expires on `createdAt + timeout` because the child has not
    // started yet, and its announcement fails retryably. The child then starts,
    // which moves the computed deadline to `startedAt + timeout`. The retry must
    // still present the observation the row already persisted, or the registry's
    // identity fence drops it and the parent is never woken.
    const createdAt = Date.now() - (RUN_TIMEOUT_SECONDS + 1) * 1_000;
    const observedStartedAt = createdAt + 1_000;
    const entry = createRunningEntry(createdAt);
    entry.execution = { status: "queued" };
    const accepted: number[] = [];
    let attempts = 0;
    // Mirrors the registry's real acceptance fence (subagent-registry.ts): the
    // observation is recorded before the announcement, and a later call whose
    // observedAt differs is rejected without notifying anyone.
    const reportSubagentWaitExpiry = vi.fn(
      async ({
        entry: current,
        observedAt,
      }: Parameters<SubagentManagerOptions["reportSubagentWaitExpiry"]>[0]) => {
        if (
          typeof current.waitExpiryAnnouncedAt === "number" ||
          (typeof current.waitExpiryObservedAt === "number" &&
            current.waitExpiryObservedAt !== observedAt)
        ) {
          return;
        }
        current.waitExpiryObservedAt ??= observedAt;
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient publication failure");
        }
        accepted.push(observedAt);
        current.waitExpiryAnnouncedAt = Date.now();
      },
    );
    const { manager, completions } = createWaitManager({
      entry,
      wait: { status: "timeout" },
      laterWaits: [{ status: "timeout", startedAt: observedStartedAt }],
      reportSubagentWaitExpiry,
      resolveSubagentSessionStartedAt: () => entry.execution.startedAt,
    });

    await manager.waitForSubagentCompletion(RUN_ID, 50, entry);
    await expect.poll(() => reportSubagentWaitExpiry.mock.calls.length).toBe(2);
    await expect.poll(() => accepted).toEqual([createdAt + RUN_TIMEOUT_SECONDS * 1_000]);
    expect(entry.waitExpiryObservedAt).toBe(createdAt + RUN_TIMEOUT_SECONDS * 1_000);
    expect(typeof entry.waitExpiryAnnouncedAt).toBe("number");
    expect(completions).toHaveLength(0);
  });

  it("reports an exited child when a stop reason proves the run settled", async () => {
    const entry = createRunningEntry(Date.now() - (RUN_TIMEOUT_SECONDS + 1) * 1_000);
    const { manager, completions } = createWaitManager({
      entry,
      wait: { status: "timeout", stopReason: "timeout" },
    });

    await manager.waitForSubagentCompletion(RUN_ID, 50, entry);

    expect(completions[0]?.outcome).toMatchObject({ disposition: "exited" });
  });
});
