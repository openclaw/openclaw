import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { admitReplyTurn } from "../../auto-reply/reply/reply-turn-admission.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { RUN_STALE_TAKEOVER_MS } from "../../logging/diagnostic-run-activity.js";
import { recoverStuckDiagnosticSession } from "../../logging/diagnostic-stuck-session-recovery.runtime.js";
import { startGatewayDiagnosticHeartbeat } from "../../logging/diagnostic.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";
import {
  createReplyOperation,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
import {
  assertSessionControllerOperation,
  isReplyRunEvidenceStale,
} from "../../sessions/session-controller.state.js";
import { testing as replyTesting } from "../../sessions/session-controller.test-support.js";
import * as controllerWait from "../../sessions/session-controller.wait.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { installSessionPlacementAdmissionProvider } from "../session-placement-admission.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { resolveActiveEmbeddedRunRecoveryBlocker } from "./run-state.js";
import type { EmbeddedAgentQueueHandle } from "./run-state.js";
import {
  createEmbeddedRunHandle,
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  testing,
  steerTestSessionTurn,
} from "./runs.test-support.js";

const sessionId = "runtime-liveness-session";
const sessionKey = "agent:main:runtime-liveness";
const runId = "runtime-liveness-run";
let admission: PreparedAgentRunAdmission;
let operation: ReplyOperation;
let handle: EmbeddedAgentQueueHandle;
let runtimeOwnsLiveness: boolean;
const abort = vi.fn();
const queueMessage = vi.fn(async () => {});

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-08-20T12:00:00Z"));
  setDiagnosticsEnabledForProcess(true);
  runtimeOwnsLiveness = true;
  admission = prepareSystemAgentRunAdmission({}, runId, "main", "runtime-liveness-test");
  const admitted = await admission.admit("embedded");
  operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
  abort.mockReset().mockImplementation(() => {
    clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    operation.complete();
  });
  queueMessage.mockClear();
  const backend = {
    ...createEmbeddedRunHandle({ runId, queueMessage, abort, guarded: true }),
    kind: "embedded" as const,
    ownsLiveness: () => runtimeOwnsLiveness,
    cancel: abort,
  };
  handle = backend;
  operation.attachBackend(backend);
  operation.setPhase("running");
  const caller = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: admitted,
    agentId: "main",
    sessionKey,
  });
  if (!caller) {
    throw new Error("liveness fixture requires an admitted Gateway caller");
  }
  const watchdogAttempt = operation.watchdog.attachAttempt({
    assertCurrent: () => assertSessionControllerOperation(operation),
  });
  await withGatewayToolCallerIdentity(
    {
      ...caller,
      watchdogAttempt,
      embeddedRunToolAuthorityBinding: (registration) => {
        const assertActive = () => {
          assertSessionControllerOperation(operation);
          if (registration.handle !== handle) {
            throw new Error("liveness fixture handle changed");
          }
        };
        return {
          source: "reply",
          acceptsRequesterOrigin: () => false,
          operation,
          watchdogAttempt,
          project: () => undefined,
          projectAsync: async () => undefined,
          assertRegistrationActive: assertActive,
          assertActive,
        };
      },
    },
    () => setActiveEmbeddedRun(sessionId, handle, sessionKey),
  );
});

afterEach(() => {
  resetDiagnosticStateForTest();
  admission.close();
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetSessionControllerForTest();
  resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("keeps runtime waits steerable after the stale window", async () => {
  await vi.advanceTimersByTimeAsync(RUN_STALE_TAKEOVER_MS + 1);

  expect(isReplyRunEvidenceStale(operation)).toBe(false);
  await expect(steerTestSessionTurn(sessionId, "continue")).resolves.toMatchObject({
    status: "accepted",
  });
  expect(queueMessage).toHaveBeenCalledOnce();
  await expect(
    recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      operation,
      ageMs: RUN_STALE_TAKEOVER_MS + 1,
      queueDepth: 1,
      allowActiveAbort: true,
    }),
  ).resolves.toMatchObject({ status: "skipped", reason: "active_reply_work" });
  expect(abort).not.toHaveBeenCalled();
});

it("reports quiet runtime waits without scheduling abort", async () => {
  const resumeRecovery = createDeferred();
  const releasePlacementProvider = installSessionPlacementAdmissionProvider({
    assertCompactionSuccessorAllowed() {},
    executeLocalTurn: async (_claim, runLocal) => await runLocal(),
    executeTurn: async (_claim, _params, runLocal) => await runLocal(),
    recoverTerminalTurn: async (_session, assertCurrent) => {
      // Keep recovery pending at the diagnostic tick regardless of module import warmth.
      await resumeRecovery.promise;
      assertCurrent?.();
      return undefined;
    },
  });
  const events: DiagnosticEventPayload[] = [];
  const unsubscribe = onDiagnosticEvent((event) => events.push(event));
  let recoveryAtDiagnosticTick: ReturnType<typeof operation.watchdog.snapshot>["recovery"];
  const recover = vi.fn((request: Parameters<typeof recoverStuckDiagnosticSession>[0]) => {
    recoveryAtDiagnosticTick = request.operation?.watchdog.snapshot().recovery;
    return recoverStuckDiagnosticSession(request);
  });
  try {
    startGatewayDiagnosticHeartbeat(
      createTestGatewayScheduler("fake-timers"),
      { diagnostics: { enabled: true } },
      { recoverStuckSession: recover },
    );
    await vi.advanceTimersByTimeAsync(RUN_STALE_TAKEOVER_MS + 60_000);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.long_running",
        reason: "runtime_owned_wait",
        sessionId,
      }),
    );
    expect(recover).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();

    runtimeOwnsLiveness = false;
    await vi.advanceTimersByTimeAsync(30_000);
    // Diagnostics request a tick from the captured controller once the runtime wait ends.
    expect(recover).toHaveBeenCalledOnce();
    expect(recover.mock.calls[0]?.[0].operation).toBe(operation);
    expect(recoveryAtDiagnosticTick).toMatchObject({ status: "pending" });
    await expect(recover.mock.results[0]?.value).resolves.toMatchObject({
      status: "skipped",
      reason: "active_reply_work",
    });
    // The controller timer started recovery before the diagnostic projection observed it.
    resumeRecovery.resolve();
    await operation.ownerSettlement;
    expect(abort).toHaveBeenCalledOnce();
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
  } finally {
    resumeRecovery.resolve();
    operation.complete();
    await operation.ownerSettlement;
    releasePlacementProvider();
    unsubscribe();
  }
});

it("waits in bounded slices, then reclaims host-owned work without a millisecond spin", async () => {
  vi.advanceTimersByTime(RUN_STALE_TAKEOVER_MS + 1);
  await Promise.resolve();
  const waitForIdleImpl = controllerWait.waitForSessionRunIdle;
  const waits = [createDeferred(), createDeferred()] as const;
  const waitForIdle = vi
    .spyOn(controllerWait, "waitForSessionRunIdle")
    .mockImplementation((...args) => {
      const result = waitForIdleImpl(...args);
      waits[waitForIdle.mock.calls.length - 1]?.resolve();
      return result;
    });

  const callerAbort = new AbortController();
  let settled = false;
  const waiting = admitReplyTurn({
    sessionId,
    sessionKey,
    kind: "visible",
    resetTriggered: false,
    upstreamAbortSignal: callerAbort.signal,
  }).then((result) => {
    settled = true;
    return result;
  });
  try {
    await waits[0].promise;
    vi.advanceTimersByTime(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
    await waits[1].promise;
    expect(settled).toBe(false);
    expect(abort).not.toHaveBeenCalled();
    expect(waitForIdle.mock.calls.length).toBeGreaterThan(1);
    expect(new Set(waitForIdle.mock.calls.map(([, timeout]) => timeout))).toEqual(
      new Set([REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS]),
    );

    runtimeOwnsLiveness = false;
    vi.advanceTimersByTime(1_000);
    const result = await waiting;
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
    expect(result.status).toBe("owned");
  } finally {
    callerAbort.abort();
    const result = await waiting;
    if (result.status === "owned") {
      result.operation.complete();
    }
  }
});

it.each(["aborted", "stopped", "probe-error"] as const)("does not protect %s work", (state) => {
  if (state === "aborted") {
    handle.isAborted = () => true;
  } else if (state === "stopped") {
    handle.isStopped = () => true;
  } else {
    handle.ownsLiveness = () => {
      throw new Error("runtime probe failed");
    };
  }
  expect(resolveActiveEmbeddedRunRecoveryBlocker(sessionId)).toBeUndefined();
});

it("rechecks ownership after a probe replaces the handle", async () => {
  handle.ownsLiveness = () => {
    setActiveEmbeddedRun(sessionId, { ...handle, ownsLiveness: undefined }, sessionKey);
    return true;
  };
  await vi.advanceTimersByTimeAsync(RUN_STALE_TAKEOVER_MS + 1);
  await expect(steerTestSessionTurn(sessionId, "continue")).resolves.toMatchObject({
    status: "rejected",
    reason: "no_active_run",
  });
  expect(queueMessage).not.toHaveBeenCalled();
});

it("does not let a probe revive closed admission", () => {
  handle.ownsLiveness = () => {
    admission.close();
    return true;
  };
  expect(resolveActiveEmbeddedRunRecoveryBlocker(sessionId)).toBeUndefined();
});
