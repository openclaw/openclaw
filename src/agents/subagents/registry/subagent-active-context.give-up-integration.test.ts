// Real-behavior integration proof for the give-up terminal `failed` delivery
// leak (#154834): drive the actual SubagentLifecycleController give-up path
// (finalizeResumedAnnounceGiveUp -> completeCleanupBookkeeping) so it stamps a
// real cleanupCompletedAt, register the resulting record in the live subagent
// registry, then render the real requester runtime-context block through
// buildActiveSubagentRuntimeContext. This complements the unit assertions in
// subagent-active-context.test.ts with an end-to-end path that never hand-sets
// cleanupCompletedAt.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { buildActiveSubagentRuntimeContext } from "./subagent-active-context.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle-context.js";
import { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const helperMocks = vi.hoisted(() => ({
  safeRemoveAttachmentsDir: vi.fn(async () => {}),
  logAnnounceGiveUp: vi.fn(),
}));

// Keep best-effort filesystem/log side effects inert; the delivery state
// transitions under test are pure in-memory record mutations.
vi.mock("./subagent-registry-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-registry-helpers.js")>()),
  safeRemoveAttachmentsDir: helperMocks.safeRemoveAttachmentsDir,
  logAnnounceGiveUp: helperMocks.logAnnounceGiveUp,
}));

vi.mock("../../../runtime.js", () => ({
  defaultRuntime: { log: vi.fn() },
}));

const CONTROLLER_SESSION_KEY = "agent:main:main";

function createLifecycleController(
  entry: SubagentRunRecord,
  runs: Map<string, SubagentRunRecord>,
): SubagentLifecycleController {
  const options: SubagentLifecycleOptions = {
    runs,
    resumedRuns: new Set(),
    subagentAnnounceTimeoutMs: 1_000,
    getRuntimeConfig: () => ({}) as OpenClawConfig,
    persist: vi.fn(),
    persistOrThrow: vi.fn(),
    clearPendingLifecycleError: vi.fn(),
    countPendingDescendantRuns: () => 0,
    getLatestRunForChildSession: () => null,
    suppressAnnounceForSteerRestart: () => false,
    resolveSubagentTask: () => ({ lookup: "available" }),
    shouldEmitEndedHookForRun: () => false,
    emitSubagentEndedHookForRun: vi.fn(async () => {}),
    emitSubagentProgressEndedForRun: vi.fn(async () => {}),
    notifyContextEngineSubagentEnded: vi.fn(async () => {}),
    retireSupersededRun: vi.fn(async () => {}),
    resumeSubagentRun: vi.fn(),
    callGateway: vi.fn(async () => ({}) as never),
    captureSubagentCompletionReply: vi.fn(async () => undefined),
    runSubagentAnnounceFlow: vi.fn(async () => "retryable" as const),
    maybeWakeRequesterAfterAllChildrenSettled: vi.fn(async () => false),
    warn: vi.fn(),
  };
  return new SubagentLifecycleController(options);
}

function makeAbandonedFailedEntry(): SubagentRunRecord {
  // A required-completion child that ended with an error outcome: give-up marks
  // its delivery failed (not suspended) and completes cleanup bookkeeping.
  return {
    runId: "run-abandoned-failed",
    childSessionKey: "agent:main:subagent:abandoned-failed",
    controllerSessionKey: CONTROLLER_SESSION_KEY,
    requesterSessionKey: CONTROLLER_SESSION_KEY,
    requesterDisplayKey: "main",
    task: "deliver the abandoned report",
    cleanup: "keep",
    createdAt: 1_000,
    endedReason: SUBAGENT_ENDED_REASON_ERROR,
    expectsCompletionMessage: true,
    completion: { required: true, resultText: "abandoned give-up result" },
    delivery: { status: "pending", lastError: "gateway request timeout for agent" },
    execution: {
      status: "terminal",
      startedAt: 2_000,
      endedAt: 4_000,
      outcome: { status: "error", error: "gateway request timeout for agent" },
    },
  } satisfies SubagentRunRecord;
}

describe("give-up terminal failed delivery runtime-context integration", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    helperMocks.safeRemoveAttachmentsDir.mockClear();
    helperMocks.logAnnounceGiveUp.mockClear();
  });

  afterEach(() => {
    resetSubagentRegistryForTests();
  });

  it("omits an abandoned failed child from awaiting delivery while keeping a pending sibling", async () => {
    const abandoned = makeAbandonedFailedEntry();
    const pending: SubagentRunRecord = {
      runId: "run-pending-sibling",
      childSessionKey: "agent:main:subagent:pending-sibling",
      controllerSessionKey: CONTROLLER_SESSION_KEY,
      requesterSessionKey: CONTROLLER_SESSION_KEY,
      requesterDisplayKey: "main",
      task: "deliver the live report",
      cleanup: "keep",
      createdAt: 1_500,
      expectsCompletionMessage: true,
      completion: { required: true, resultText: "live pending result" },
      delivery: { status: "pending" },
      execution: { status: "terminal", startedAt: 2_500, endedAt: 4_500 },
    } satisfies SubagentRunRecord;

    // Register both children in the live registry the runtime-context builder
    // reads. addSubagentRunForTests stores by reference, so the controller's
    // give-up mutations below are the same records the builder sees.
    addSubagentRunForTests(abandoned);
    addSubagentRunForTests(pending);

    const registeredAbandoned = subagentRuns.get(abandoned.runId)!;
    const registeredPending = subagentRuns.get(pending.runId)!;

    // Before give-up: the abandoned child is still pending, so it renders.
    const before = buildActiveSubagentRuntimeContext({
      cfg: {} as OpenClawConfig,
      controllerSessionKey: CONTROLLER_SESSION_KEY,
    });
    expect(before).toContain("## Child results awaiting delivery");
    expect(before).toContain("abandoned give-up result");
    expect(registeredAbandoned.cleanupCompletedAt).toBeUndefined();

    // Drive the REAL give-up path; it must produce delivery.status="failed" and
    // stamp cleanupCompletedAt itself (no hand-set marker).
    const controller = createLifecycleController(registeredAbandoned, subagentRuns as never);
    await controller.finalizeResumedAnnounceGiveUp({
      runId: registeredAbandoned.runId,
      entry: registeredAbandoned,
      reason: "permanent_failure",
    });
    // A consumed requester settle wake no longer owns delivery; the dead row is
    // left as failed + cleanupCompletedAt, exactly the persisted leak shape.
    registeredAbandoned.requesterSettleWake = undefined;

    expect(registeredAbandoned.delivery?.status).toBe("failed");
    expect(registeredAbandoned.cleanupCompletedAt).toBeTypeOf("number");
    expect(registeredPending.delivery?.status).toBe("pending");
    expect(registeredPending.cleanupCompletedAt).toBeUndefined();

    const after = buildActiveSubagentRuntimeContext({
      cfg: {} as OpenClawConfig,
      controllerSessionKey: CONTROLLER_SESSION_KEY,
    });

    // Evidence: the abandoned give-up result is gone from the awaiting-delivery
    // block, while the genuinely pending sibling is retained.
    expect(after).toContain("## Child results awaiting delivery");
    expect(after).toContain("live pending result");
    expect(after).not.toContain("abandoned give-up result");

    // Pin the exact rendered block bytes as quotable real-behavior evidence: the
    // awaiting-delivery section lists only the pending sibling after the real
    // give-up flow drained the abandoned failed child.
    const deliveryBlock = (after ?? "").slice(
      (after ?? "").indexOf("## Child results awaiting delivery"),
    );
    expect(deliveryBlock).toBe(
      [
        "## Child results awaiting delivery",
        '- run_json="run-pending-sibling"; session_json="agent:main:subagent:pending-sibling"; ' +
          "outcome=unknown; delivery=pending; requester_continuation=none; " +
          'task_json="deliver the live report"; result_json="live pending result"; ' +
          "result_truncated=false",
      ].join("\n"),
    );
    expect(deliveryBlock).not.toContain("run-abandoned-failed");
  });
});
