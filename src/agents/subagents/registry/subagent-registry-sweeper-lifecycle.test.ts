// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentRestartRecoveryFixture } from "./subagent-restart-recovery.test-support.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
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
import * as reconciliation from "./subagent-session-reconciliation.js";

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
    createSubagentRunParams({
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      sessionEntry: { sessionId: `sess-${runId}`, lifecycleRevision: `revision-${runId}` },
    }),
  );
}

async function advance(ms: number, expectedSweeps?: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.dynamicImportSettled();
  if (expectedSweeps !== undefined) {
    expect(recoverRow).toHaveBeenCalledTimes(expectedSweeps);
  }
}

async function startPendingSweep(runId: string) {
  const pending = createDeferred<{ status: "handled" }>();
  recoverRow.mockReturnValueOnce(pending.promise);
  await register(runId);
  await vi.dynamicImportSettled();
  return pending;
}

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

it("activates after restoring custody while shutdown retains interrupted recovery", async ({
  signal,
}) => {
  await register("restored");
  await resetSubagentRegistryForTests({ persist: false });
  await initSubagentRegistry();
  const readEntered = createDeferred();
  const readReleased = createDeferred();
  const recoveryEntered = createDeferred();
  const recoveryReleased = createDeferred<{ status: "handled" }>();
  using _ = vi.spyOn(reconciliation, "loadSubagentSessionEntry").mockImplementation(async () => {
    readEntered.resolve();
    await readReleased.promise;
    return {
      sessionId: "sess-restored",
      lifecycleRevision: "revision-restored",
      updatedAt: 1,
      abortedLastRun: true,
    };
  });
  recoverRow.mockImplementationOnce(() => {
    recoveryEntered.resolve();
    return recoveryReleased.promise;
  });
  let activated = false;
  let retired = false;
  let retirement: Promise<void> | undefined;
  const activation = activateGatewayRuntime().then(() => {
    activated = true;
  });
  try {
    await withinTest(readEntered.promise, signal);
    await advance(0);
    expect(activated).toBe(false);
    expect(recoverRow).not.toHaveBeenCalled();
    readReleased.resolve();
    await withinTest(recoveryEntered.promise, signal);
    await advance(0);
    expect(activated).toBe(true);
    retirement = resetSubagentRegistryForTests({ persist: false }).then(() => {
      retired = true;
    });
    await advance(0);
    expect(retired).toBe(false);
  } finally {
    readReleased.resolve();
    recoveryReleased.resolve({ status: "handled" });
    await activation;
    await retirement;
  }
  expect(retired).toBe(true);
});

it("cancels last-row sweeps and restores cadence", async () => {
  await register("released");
  await vi.dynamicImportSettled();
  expect(subagentRuns.has("released")).toBe(true);
  await releaseSubagentRun("released");
  expect(subagentRuns.size).toBe(0);
  await vi.dynamicImportSettled();
  markGatewayRestartDraining();

  await advance(60_000, 0);
  expect(warn).not.toHaveBeenCalled();

  resetGatewayWorkAdmission();
  await register("next");
  await vi.dynamicImportSettled();
  await advance(59_999, 0);
  await advance(1);
  expect(recoverRow).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runId: "next" }));
});

it.each([false, true])("resumes retained sweeps (suspended=%s)", async (suspended) => {
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
  await advance(60_000, 0);
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "subagent run sweep skipped: gateway is draining for restart",
    undefined,
  );
  expect(subagentRuns.has("retained")).toBe(true);

  resetGatewayWorkAdmission();
  await activateGatewayRuntime();
  await advance(4_999, 0);
  await advance(1);
  expect(recoverRow).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ runId: "retained" }),
  );
  await advance(59_999, 1);
  await advance(1, 2);
  expect(subagentRuns.has("retained")).toBe(true);
});

it.each([false, true])("settles overlapping sweeps (released=%s)", async (released) => {
  const pending = await startPendingSweep("active");
  try {
    await advance(60_000, 1);
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    scheduleSubagentRegistrySweep({ delayMs: 1 });
    await advance(1, 1);
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
  await advance(0, released ? 1 : 2);
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  if (released) {
    await advance(60_000);
  }
  expect(warn).not.toHaveBeenCalled();
});

it.each([
  { successor: true, rejection: false },
  { successor: false, rejection: true },
])(
  "joins retirement (successor=$successor, rejection=$rejection)",
  async ({ successor, rejection }) => {
    const pending = await startPendingSweep("retiring");
    await advance(60_000, 1);
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    let retired = false;
    const retirement = resetSubagentRegistryForTests({ persist: false }).then(() => {
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
    await advance(59_999, 1);
    await advance(1, successor ? 2 : 1);
  },
);
