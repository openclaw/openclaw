import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  initSubagentRegistry,
  registerSubagentRun,
  releaseSubagentRun,
  resetSubagentRegistryForTests,
  scheduleSubagentRegistrySweep,
} from "./subagent-registry.test-helpers.js";
import { useSubagentRestartRecoveryFixture } from "./subagent-restart-recovery.test-support.js";

const recoverRow = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock("./subagent-registry-restart-recovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-registry-restart-recovery.js")>()),
  recoverInterruptedSubagentRow: recoverRow,
}));
vi.mock("../../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "agents/subagent-registry" ? { ...logger, warn } : logger;
    },
  };
});

async function register(runId: string) {
  await registerSubagentRun(
    createSubagentRunParams({ runId, childSessionKey: `agent:main:subagent:${runId}` }),
  );
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.dynamicImportSettled();
}

describe("registered subagent sweeper lifecycle", () => {
  const { activateGatewayRuntime } = useSubagentRestartRecoveryFixture();

  beforeEach(async () => {
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
    recoverRow.mockReset().mockResolvedValue({ status: "handled" });
    warn.mockClear();
    await import("./subagent-registry-restart-recovery.js");
  });

  afterEach(async () => {
    await vi.dynamicImportSettled();
    resetSubagentRegistryForTests({ persist: false });
    resetGatewayWorkAdmission();
    vi.useRealTimers();
  });

  it("cancels the queued sweep through last-row release and restores registration cadence", async () => {
    await register("released");
    await vi.dynamicImportSettled();
    expect(subagentRuns.has("released")).toBe(true);
    releaseSubagentRun("released");
    expect(subagentRuns.size).toBe(0);
    await vi.dynamicImportSettled();
    markGatewayRestartDraining();

    await advance(60_000);
    expect(recoverRow).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    resetGatewayWorkAdmission();
    await register("next");
    await vi.dynamicImportSettled();
    await advance(59_999);
    expect(recoverRow).not.toHaveBeenCalled();
    await advance(1);
    expect(recoverRow).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runId: "next" }));
  });

  it.each([false, true])(
    "resumes retained-row periodic sweeps through repeated activateSubagentRegistry (suspended: %s)",
    async (suspended) => {
      initSubagentRegistry();
      await register("retained");
      activateGatewayRuntime();
      await vi.dynamicImportSettled();
      if (suspended) {
        expect(tryBeginGatewaySuspendAdmission(() => {})).not.toBeNull();
      } else {
        markGatewayRestartDraining();
      }
      await advance(5_000);
      if (suspended) {
        expect(warn).not.toHaveBeenCalled();
        markGatewayRestartDraining();
      }
      await advance(60_000);
      expect(recoverRow).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "subagent run sweep skipped: gateway is draining for restart",
        undefined,
      );
      expect(subagentRuns.has("retained")).toBe(true);

      resetGatewayWorkAdmission();
      activateGatewayRuntime();
      await advance(4_999);
      expect(recoverRow).not.toHaveBeenCalled();
      await advance(1);
      expect(recoverRow).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ runId: "retained" }),
      );
      await advance(59_999);
      expect(recoverRow).toHaveBeenCalledOnce();
      await advance(1);
      expect(recoverRow).toHaveBeenCalledTimes(2);
      expect(subagentRuns.has("retained")).toBe(true);
    },
  );

  it.each([false, true])(
    "settles timeout-driven overlapping sweeps (last row released: %s)",
    async (released) => {
      const pending = createDeferred<{ status: "handled" }>();
      recoverRow.mockReturnValueOnce(pending.promise);
      await register("active");
      await vi.dynamicImportSettled();
      try {
        await advance(60_000);
        expect(recoverRow).toHaveBeenCalledOnce();
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        scheduleSubagentRegistrySweep({ delayMs: 1 });
        await advance(1);
        expect(recoverRow).toHaveBeenCalledOnce();
        if (released) {
          releaseSubagentRun("active");
          expect(subagentRuns.size).toBe(0);
          await vi.dynamicImportSettled();
          expect(getActiveGatewayRootWorkCount()).toBe(1);
          markGatewayRestartDraining();
        }
      } finally {
        pending.resolve({ status: "handled" });
        await vi.dynamicImportSettled();
      }
      await advance(0);
      expect(recoverRow).toHaveBeenCalledTimes(released ? 1 : 2);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      if (released) {
        await advance(60_000);
      }
      expect(warn).not.toHaveBeenCalled();
    },
  );
});
