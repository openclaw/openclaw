import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let tmpDir: string;
const { makeMainSessionFixture } = createRestartRecoveryStoreFixture(() => tmpDir);
type Dispatch = GatewayRecoveryRuntime["dispatchAgent"];

it.each(["ok", "error", "queued"] as const)(
  "retains recovery admission through %s dispatch",
  async (mode) => {
    tmpDir = tempDirs.make("openclaw-recovery-source-admission-");
    const dispatchSettlement = createDeferred();
    resetAgentEventsForTest();
    resetGatewayWorkAdmission();
    setRuntimeConfigSnapshot({});
    try {
      const { storePath, sessionKey, readEntry } = await makeMainSessionFixture({
        pendingFinalDelivery: makePendingFinalDelivery(),
      });
      const callGateway = vi.fn(async (_request: unknown) => ({ runId: "run-resumed" }));
      const accepted = createDeferred();
      let executionStarted = mode !== "queued";
      let dispatchOptions: Parameters<Dispatch>[2];
      const runtime: GatewayRecoveryRuntime = {
        ...createRecoveryRuntimeFixture({
          callGateway,
          getDispatchSettlement: () => dispatchSettlement.promise,
          sendRecoveryNotice: async () => ({ suppressed: false }),
        }),
        dispatchAgent: async <T>(...[request, , options]: Parameters<Dispatch>) => {
          dispatchOptions = options;
          if (mode === "queued") {
            await callGateway({ method: "agent", params: request });
          }
          options?.onStartOwner?.({
            // Queued inputs have no start deadline.
            observe: () =>
              executionStarted
                ? { executionStarted }
                : { executionStarted, startDeadlineAtMs: null },
            abort: () => false,
          });
          options?.onAccepted?.({ runId: request.idempotencyKey, status: "accepted" });
          if (executionStarted) {
            options?.onExecutionStarted?.();
          }
          accepted.resolve();
          await dispatchSettlement.promise;
          if (mode === "error") {
            throw new Error("recovery dispatch failed");
          }
          return { runId: request.idempotencyKey, status: "ok" } as T;
        },
      };
      if (mode === "queued") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const recovery = retryRestartAbortedMainSessionRecovery({
        expectedSessionId: "main-session",
        gatewayRuntime: runtime,
        sessionKey,
        storePath,
      });
      if (mode === "queued") {
        await accepted.promise;
        await vi.advanceTimersByTimeAsync(60_000);
        executionStarted = true;
        dispatchOptions?.onExecutionStarted?.();
      }
      await expect(recovery).resolves.toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
      if (mode === "queued") {
        expect(callGateway).toHaveBeenCalledOnce();
        expect(readEntry()?.mainRestartRecovery).toMatchObject({ chargedAttempts: 1 });
      } else {
        const assertCurrent = dispatchOptions?.assertAdmissionCurrent;
        expect(assertCurrent).toBeTypeOf("function");
        expect(() => assertCurrent!()).not.toThrow();
        dispatchSettlement.resolve();
        await vi.waitFor(() =>
          expect(() => assertCurrent!()).toThrow(
            "Restart recovery admission is no longer current.",
          ),
        );
      }
    } finally {
      dispatchSettlement.resolve();
      if (mode === "queued") {
        vi.useRealTimers();
      }
      resetGatewayWorkAdmission();
      await cleanupSessionStateForTest({ stateDir: tmpDir });
      clearRuntimeConfigSnapshot();
    }
  },
);
