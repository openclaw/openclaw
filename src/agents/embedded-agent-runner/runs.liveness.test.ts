import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { resolveActiveEmbeddedRunRecoveryBlocker } from "./run-state.js";
import type { EmbeddedAgentQueueHandle } from "./run-state.js";
import {
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
    kind: "embedded" as const,
    runId,
    queueMessage,
    messageInjectionV2: {
      version: 2 as const,
      isAvailable: () => true,
      queueMessage: async (_text: string, _options: unknown, assertCurrent: () => void) => {
        assertCurrent();
        return queueMessage();
      },
    },
    isStreaming: () => true,
    isCompacting: () => false,
    ownsLiveness: () => runtimeOwnsLiveness,
    abort,
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
      embeddedRunToolAuthorityBinding: (registration) => ({
        source: "reply",
        operation,
        watchdogAttempt,
        project: () => undefined,
        projectAsync: async () => undefined,
        assertActive: () => {
          assertSessionControllerOperation(operation);
          if (registration.handle !== handle) {
            throw new Error("liveness fixture handle changed");
          }
        },
      }),
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

describe("runtime-owned embedded liveness", () => {
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
      await operation.ownerSettlement;
      expect(abort).toHaveBeenCalledOnce();
      expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
    } finally {
      unsubscribe();
    }
  });

  it("waits in bounded slices, then reclaims host-owned work without a millisecond spin", async () => {
    vi.advanceTimersByTime(RUN_STALE_TAKEOVER_MS + 1);
    await Promise.resolve();
    const waitForIdleImpl = controllerWait.waitForSessionRunIdle;
    let resolveFirstWait!: () => void;
    let resolveSecondWait!: () => void;
    const firstWait = new Promise<void>((resolve) => {
      resolveFirstWait = resolve;
    });
    const secondWait = new Promise<void>((resolve) => {
      resolveSecondWait = resolve;
    });
    const waitForIdle = vi
      .spyOn(controllerWait, "waitForSessionRunIdle")
      .mockImplementation((...args) => {
        const result = waitForIdleImpl(...args);
        if (waitForIdle.mock.calls.length === 1) {
          resolveFirstWait();
        } else if (waitForIdle.mock.calls.length === 2) {
          resolveSecondWait();
        }
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
      await firstWait;
      vi.advanceTimersByTime(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      await secondWait;
      expect(settled).toBe(false);
      expect(abort).not.toHaveBeenCalled();
      expect(waitForIdle.mock.calls.length).toBeGreaterThan(1);
      expect(
        waitForIdle.mock.calls.every(
          ([, timeoutMs]) => timeoutMs === REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
        ),
      ).toBe(true);

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
});
