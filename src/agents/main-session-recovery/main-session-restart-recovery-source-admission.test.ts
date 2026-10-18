import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { callGateway } from "../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import {
  createRestartRecoveryStoreFixture,
  makePendingFinalDelivery,
} from "./main-session-restart-recovery-fixture.test-support.js";
import { retryRestartAbortedMainSessionRecovery } from "./main-session-restart-recovery.js";

// mock-isolation: Recovery dispatch settlement is held by the fixture instead of opening a Gateway connection.
vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-resumed" })),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let dispatchSettlement = createDeferred();
const gatewayRuntime = createRecoveryRuntimeFixture({
  callGateway,
  getDispatchSettlement: () => dispatchSettlement.promise,
  sendRecoveryNotice: async () => ({ suppressed: false }),
});

describe("restart recovery source admission", () => {
  let tmpDir: string;
  const { makeMainSessionFixture } = createRestartRecoveryStoreFixture(() => tmpDir);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callGateway).mockReset().mockResolvedValue({ runId: "run-resumed" });
    dispatchSettlement = createDeferred();
    resetAgentEventsForTest();
    resetGatewayWorkAdmission();
    tmpDir = tempDirs.make("openclaw-recovery-source-admission-");
    setRuntimeConfigSnapshot({});
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    await cleanupSessionStateForTest({ stateDir: tmpDir });
    clearRuntimeConfigSnapshot();
  });

  it.for(["ok", "error"] as const)(
    "retains recovery source admission after execution starts until dispatch settles (%s)",
    async (terminalStatus) => {
      const { storePath, sessionKey } = await makeMainSessionFixture({
        pendingFinalDelivery: makePendingFinalDelivery(),
      });
      let assertAdmissionCurrent: (() => void) | undefined;
      const runtime: GatewayRecoveryRuntime = {
        ...gatewayRuntime,
        dispatchAgent: async <T>(
          request: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[0],
          _timeoutMs?: number,
          options?: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
        ) => {
          assertAdmissionCurrent = options?.assertAdmissionCurrent;
          options?.onStartOwner?.({
            observe: () => ({ executionStarted: true }),
            abort: () => false,
          });
          options?.onAccepted?.({ runId: request.idempotencyKey, status: "accepted" });
          options?.onExecutionStarted?.();
          await dispatchSettlement.promise;
          if (terminalStatus === "error") {
            throw new Error("recovery dispatch failed");
          }
          return { runId: request.idempotencyKey, status: terminalStatus } as T;
        },
      };
      try {
        await expect(
          retryRestartAbortedMainSessionRecovery({
            expectedSessionId: "main-session",
            gatewayRuntime: runtime,
            sessionKey,
            storePath,
          }),
        ).resolves.toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
        expect(assertAdmissionCurrent).toBeTypeOf("function");
        expect(() => assertAdmissionCurrent!()).not.toThrow();
        dispatchSettlement.resolve();
        await vi.waitFor(() =>
          expect(() => assertAdmissionCurrent!()).toThrow(
            "Restart recovery admission is no longer current.",
          ),
        );
      } finally {
        dispatchSettlement.resolve();
      }
    },
  );

  it("keeps a queued resend waiting past the start observation without another attempt", async () => {
    const { storePath, sessionKey } = await makeMainSessionFixture({
      pendingFinalDelivery: makePendingFinalDelivery(),
    });
    const accepted = createDeferred();
    let executionStarted = false;
    let markStarted: (() => void) | undefined;
    // The Gateway reports a queued input's start budget as null (no deadline).
    const queuedRuntime: GatewayRecoveryRuntime = {
      ...gatewayRuntime,
      dispatchAgent: async <T>(
        request: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[0],
        _timeoutMs?: number,
        options?: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
      ) => {
        await callGateway({ method: "agent", params: request });
        options?.onStartOwner?.({
          observe: () =>
            executionStarted ? { executionStarted } : { executionStarted, startDeadlineAtMs: null },
          abort: () => false,
        });
        options?.onAccepted?.({ runId: request.idempotencyKey, status: "accepted" });
        markStarted = options?.onExecutionStarted;
        accepted.resolve();
        await dispatchSettlement.promise;
        return { runId: request.idempotencyKey, status: "ok" } as T;
      },
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const recovery = retryRestartAbortedMainSessionRecovery({
        expectedSessionId: "main-session",
        gatewayRuntime: queuedRuntime,
        sessionKey,
        storePath,
      });
      await accepted.promise;
      await vi.advanceTimersByTimeAsync(60_000);
      executionStarted = true;
      markStarted?.();
      await expect(recovery).resolves.toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(callGateway).toHaveBeenCalledOnce();
      expect(loadSessionEntry({ storePath, sessionKey })?.mainRestartRecovery).toMatchObject({
        chargedAttempts: 1,
      });
    } finally {
      dispatchSettlement.resolve();
      vi.useRealTimers();
    }
  });
});
