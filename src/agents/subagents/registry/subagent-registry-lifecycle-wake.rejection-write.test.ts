import { describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { mutateRequesterCompletionBatch } from "../completion/subagent-completion-admission.store.js";
import {
  SubagentLifecycleController,
  type SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// Keep completion, session cleanup, and transport outside this settlement proof.
// mock-isolation: Run completion writes terminal state through the state worker; only the settle write is under test.
vi.mock("./subagent-registry-lifecycle-completion.js", () => ({
  completeSubagentRunAttempt: vi.fn(),
}));
// mock-isolation: Announce cleanup delivers through the Gateway and deletes child sessions; only the settle write is under test.
vi.mock("./subagent-registry-lifecycle-announce-cleanup.js", () => ({
  finalizeResumedAnnounceGiveUp: vi.fn(),
  resumeAncestorCleanup: vi.fn(),
  startSubagentAnnounceCleanupFlow: vi.fn(),
}));
// mock-isolation: Requester-turn settlement reads run liveness through the state worker; only the settle write is under test.
vi.mock("./subagent-registry-requester-yield.js", () => ({
  settleRequesterTurnAfterSessionSpawns: vi.fn(),
}));
// mock-isolation: Delivery-state writes go to the session store through the state worker; only the settle write is under test.
vi.mock("./subagent-registry-lifecycle-delivery.js", () => ({
  buildSafeLifecycleErrorMeta: (error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  }),
  clearSubagentPendingDelivery: vi.fn(),
  markRequesterSettleWakePending: vi.fn(),
  maskLifecycleIdentifier: () => "synthetic",
  refreshFrozenResultFromSession: vi.fn(),
  safeSetSubagentTaskDeliveryStatus: vi.fn(),
}));
// mock-isolation: The completion batch publishes without the admission store's database writes.
// The wake's catch path classifies the store's real error classes (upstream #186443).
vi.mock("../completion/subagent-completion-admission.store.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../completion/subagent-completion-admission.store.js")
  >()),
  blockSubagentCompletionDelivery: vi.fn(),
  // Upstream 10e951e857 reads the settlement's publication receipt.
  mutateRequesterCompletionBatch: vi.fn(async () => ({ applied: true, publication: "published" })),
}));
// mock-isolation: MCP runtime retirement tears down the process-wide session MCP runtimes; only the settle write is under test.
vi.mock("../../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: vi.fn(),
}));
// mock-isolation: Internal session-effect cleanup writes the agent database; only the settle write is under test.
vi.mock("../../internal-session-effects.js", () => ({
  removeInternalSessionEffectsSession: vi.fn(),
}));
// mock-isolation: Cron authority revocation mutates the process-wide requester authority table; only the settle write is under test.
vi.mock("../requester-cron-authority.js", () => ({
  revokeRequesterCronAuthorityBatch: vi.fn(),
}));
// Upstream 14fe10d01c's registry state module reads immutableSubagentRun at load
// and the controller resolves owners through getCurrentSubagentRunOwner, so keep
// the real pure helpers and replace only the process-wide run map. Upstream #201563
// admits the wake's batch through the registry's completion-authority policy; this
// row holds no completion custody, so the real policy runs with none.
vi.mock("./subagent-registry-memory.js", async (importOriginal) => {
  const { selectCompletionAuthorityBatch } =
    await import("./subagent-completion-batch-authority.js");
  return {
    ...(await importOriginal<typeof import("./subagent-registry-memory.js")>()),
    subagentRuns: {
      confirmRetirement: vi.fn(),
      selectCompletionAuthorityBatch: (
        observed: readonly SubagentRunRecord[],
        anchor: SubagentRunRecord,
      ) => selectCompletionAuthorityBatch(observed, anchor, new Map(), new WeakSet()),
    },
  };
});
// mock-isolation: Runtime log lines are dropped instead of writing to the terminal.
vi.mock("../../../runtime.js", () => ({ defaultRuntime: { log: vi.fn() } }));
// mock-isolation: Drop subsystem log lines without loading the logging runtime or its process-wide sinks.
vi.mock("../../../logging/subsystem.js", () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), child: () => logger };
  return { createSubsystemLogger: () => logger };
});

type Harness = {
  readonly controller: SubagentLifecycleController;
  readonly entry: SubagentRunRecord;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly origin: AsyncWorkScope;
};

function buildHarness(wakeFailure: Error): Harness {
  const entry: SubagentRunRecord = {
    runId: "rejection-run",
    childSessionKey: "agent:main:subagent:rejection-child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "return the child result",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "terminal", endedAt: 4_000 },
    expectsCompletionMessage: false,
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      rearmGeneration: 1,
    },
  };
  const runs = new Map([[entry.runId, entry]]);
  const warn = vi.fn();
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected completion, cleanup, or transport effect");
  };
  const wake: SubagentLifecycleOptions["maybeWakeRequesterAfterAllChildrenSettled"] = async () => {
    throw wakeFailure;
  };
  const controller = new SubagentLifecycleController({
    runs,
    resumedRuns: new Set(),
    subagentAnnounceTimeoutMs: 1_000,
    getRuntimeConfig: () => ({}),
    // Upstream 14fe10d01c removed the injected persist callbacks; registry writes go
    // through mutateSubagentRuns, and the rejection itself reaches the mocked
    // mutateRequesterCompletionBatch below, so this proof needs no persistence stub.
    clearPendingLifecycleError: vi.fn(),
    countPendingDescendantRuns: async () => 0,
    getLatestRunForChildSession: () => null,
    suppressAnnounceForSteerRestart: () => false,
    shouldEmitEndedHookForRun: () => false,
    emitSubagentEndedHookForRun: unexpected,
    emitSubagentProgressEndedForRun: unexpected,
    notifyContextEngineSubagentEnded: unexpected,
    retireSupersededRun: unexpected,
    resumeSubagentRun: vi.fn(),
    // The fixture row holds no provisional kill, so settlement never confirms one.
    confirmProvisionalKill: vi.fn(),
    callGateway: unexpected,
    captureSubagentCompletionReply: unexpected,
    cleanupBrowserSessionsForLifecycleEnd: unexpected,
    runSubagentAnnounceFlow: unexpected,
    maybeWakeRequesterAfterAllChildrenSettled: wake,
    warn,
  });
  return { controller, entry, warn, origin: new AsyncWorkScope() };
}

function warnedMessages(warn: ReturnType<typeof vi.fn>): string[] {
  return warn.mock.calls.map((call) => String(call[0]));
}

// A requester settle wake that fails must be able to record its own rejection
// through completeRequesterSettleWakeBatch with an outcome. The original defect
// (the rejection write resolving the owning detached task first and throwing
// "subagent completion owner unavailable before settlement" forever once that
// task was gone) was a Tasks-runtime owner lookup; the Tasks/TaskFlow removal
// (6652f7eac8) deleted that lookup, so only the surviving
// contract is pinned here.
describe("requester settle wake rejection write", () => {
  it("records the rejection through settlement when the completion owner is available", async () => {
    vi.clearAllMocks();
    resetGatewayWorkAdmission();
    const { controller, entry, warn, origin } = buildHarness(new Error("wake transport refused"));
    try {
      origin.run(() => controller.resumeRequesterSettleWake(entry.runId, entry));
      await vi.waitFor(() => {
        expect(warnedMessages(warn)).toContain("requester settle wake failed");
      });
      // The rejection write succeeds, so the caller never observes a rethrow.
      expect(warnedMessages(warn)).not.toContain(
        "failed to persist requester settle wake rejection",
      );
      // The rejection reached settlement carrying the failed outcome. Disarming the
      // row is mutateRequesterCompletionBatch's job and is mocked out of this proof;
      // what matters here is that the write was ATTEMPTED and did not throw.
      expect(mutateRequesterCompletionBatch).toHaveBeenCalledTimes(1);
      const settled = vi.mocked(mutateRequesterCompletionBatch).mock.calls[0]?.[0];
      expect(settled?.operation).toMatchObject({
        kind: "settle",
        outcome: { delivered: false, path: "none" },
      });
      expect(settled?.entries.map((settledEntry) => settledEntry.runId)).toEqual(["rejection-run"]);
    } finally {
      // Upstream (36e277d761) folded timer cleanup into clearRuntimeState.
      controller.clearRuntimeState();
      await origin.drain();
      resetGatewayWorkAdmission();
    }
  });
});
