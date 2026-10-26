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

it.each(["ok", "error"])("retains recovery admission through %s dispatch", async (mode) => {
  tmpDir = tempDirs.make("openclaw-recovery-source-admission-");
  const settlement = createDeferred();
  resetAgentEventsForTest();
  resetGatewayWorkAdmission();
  setRuntimeConfigSnapshot({});
  try {
    const { storePath, sessionKey } = await makeMainSessionFixture({
      pendingFinalDelivery: makePendingFinalDelivery(),
    });
    const runtime: GatewayRecoveryRuntime = createRecoveryRuntimeFixture({
      callGateway: async () => ({ runId: "run-resumed" }),
      getDispatchSettlement: async () => {
        await settlement.promise;
        if (mode === "error") {
          throw new Error("recovery dispatch failed");
        }
      },
      sendRecoveryNotice: async () => ({ suppressed: false }),
    });
    const dispatch = runtime.dispatchAgent;
    let assertCurrent: NonNullable<Parameters<Dispatch>[2]>["assertAdmissionCurrent"];
    runtime.dispatchAgent = async <T>(...args: Parameters<Dispatch>) => {
      assertCurrent = args[2]?.assertAdmissionCurrent;
      return dispatch<T>(...args);
    };
    await expect(
      retryRestartAbortedMainSessionRecovery({
        expectedSessionId: "main-session",
        gatewayRuntime: runtime,
        sessionKey,
        storePath,
      }),
    ).resolves.toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(() => assertCurrent!()).not.toThrow();
    settlement.resolve();
    await vi.waitFor(() =>
      expect(() => assertCurrent!()).toThrow("Restart recovery admission is no longer current."),
    );
  } finally {
    settlement.resolve();
    resetGatewayWorkAdmission();
    await cleanupSessionStateForTest({ stateDir: tmpDir });
    clearRuntimeConfigSnapshot();
  }
});
