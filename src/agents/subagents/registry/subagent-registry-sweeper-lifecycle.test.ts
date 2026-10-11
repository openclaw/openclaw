// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentRestartRecoveryFixture } from "./subagent-restart-recovery.test-support.js";
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
  const { activateGatewayRuntime, settle } = useSubagentRestartRecoveryFixture();

  beforeEach(async () => {
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
    recoverRow.mockReset().mockResolvedValue({ status: "handled" });
    warn.mockClear();
    await import("./subagent-registry-restart-recovery.js");
  });

  afterEach(async () => {
    await vi.dynamicImportSettled();
    await resetSubagentRegistryForTests({ persist: false });
    resetGatewayWorkAdmission();
    vi.useRealTimers();
  });

  it("cancels the queued sweep through last-row release and restores registration cadence", async () => {
    await register("released");
    await vi.dynamicImportSettled();
    expect(subagentRuns.has("released")).toBe(true);
    await releaseSubagentRun("released");
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
      await initSubagentRegistry();
      await register("retained");
      await activateGatewayRuntime();
      await vi.dynamicImportSettled();
      recoverRow.mockClear();
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
      await activateGatewayRuntime();
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
          await releaseSubagentRun("active");
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

  it.each([
    { successor: false, rejection: false },
    { successor: true, rejection: false },
    { successor: false, rejection: true },
  ])(
    "joins a retiring sweep without cancelling a successor (registered: $successor, rejected: $rejection)",
    async ({ successor, rejection }) => {
      const pending = createDeferred<{ status: "handled" }>();
      recoverRow.mockReturnValueOnce(pending.promise);
      await register("retiring");
      await vi.dynamicImportSettled();
      await advance(60_000);
      expect(recoverRow).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      let retired = false;
      const registry = Reflect.get(globalThis, Symbol.for("openclaw.subagentRegistryTestApi")) as {
        resetSubagentRegistryForTests(options: { persist: false }): void | Promise<void>;
      };
      const retirement = Promise.resolve(
        registry.resetSubagentRegistryForTests({ persist: false }),
      ).then(() => {
        retired = true;
      });
      try {
        await Promise.resolve();
        expect(retired).toBe(false);
        if (successor) {
          await register("successor");
        }
      } finally {
        if (rejection) {
          pending.reject(new Error("synthetic recovery failure"));
        } else {
          pending.resolve({ status: "handled" });
        }
        await retirement;
        await advance(0);
        if (rejection) {
          await expect(settle()).rejects.toMatchObject({
            message: "Failed to settle subagent cleanup roots",
            errors: [expect.objectContaining({ message: "synthetic recovery failure" })],
          });
        }
      }
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      await advance(59_999);
      expect(recoverRow).toHaveBeenCalledOnce();
      await advance(1);
      expect(recoverRow).toHaveBeenCalledTimes(successor ? 2 : 1);
    },
  );
});
