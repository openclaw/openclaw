import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "../../../packages/normalization-core/src/record-coerce.ts";
import type { GatewayResourceSnapshot } from "../../lib/gateway-bench-profile.ts";
import {
  measureResourceOperations,
  type KitchenSinkResourcePhase,
} from "./kitchen-sink-resources.mts";

// Fixed inputs belong to the Kitchen Sink calibration contract, not production policy.
export const KITCHEN_RESOURCE_CONTROLS = {
  iterations: 10_000_000,
  checksum: 633_235_013,
  bytes: 16 * 1024 * 1024,
  intervalMs: 10,
} as const;

type ResourceState = {
  active: boolean;
  bufferBytes: number;
  timerActive: boolean;
  timerIntervalMs: number;
  timerTicks: number;
  lastCpu: { iterations: number; checksum: number } | null;
};

function resourceState(value: unknown): ResourceState {
  assert(isRecord(value), "kitchen.resources must return resource state");
  assert(
    typeof value.active === "boolean" && typeof value.timerActive === "boolean",
    "invalid resource activity",
  );
  for (const field of ["bufferBytes", "timerIntervalMs", "timerTicks"]) {
    assert(
      Number.isSafeInteger(value[field]) && Number(value[field]) >= 0,
      `invalid resource ${field}`,
    );
  }
  assert(
    value.lastCpu === null ||
      (isRecord(value.lastCpu) &&
        Number.isSafeInteger(value.lastCpu.iterations) &&
        Number.isSafeInteger(value.lastCpu.checksum)),
    "invalid CPU receipt",
  );
  return value as ResourceState;
}

function assertReset(state: ResourceState) {
  assert(state.active, "Kitchen Sink service is not active");
  assert.equal(state.bufferBytes, 0);
  assert.equal(state.timerActive, false);
  assert.equal(state.timerIntervalMs, 0);
  assert.equal(state.timerTicks, 0);
  assert.equal(state.lastCpu, null);
}

export type KitchenSinkCalibration = {
  status: "failed" | "exercised";
  phases: KitchenSinkResourcePhase[];
  states: Record<string, ResourceState>;
  signals: Record<string, { status: "observed" | "inconclusive"; value: number; expected: string }>;
  runtime?: { operationId: string; generation: number; pluginIds: string[] };
  disableReceipt?: unknown;
  postDisposalResidual: { status: "unsupported" | "observed"; reason: string };
  error?: string;
};

/** Exercise the fixture through real RPCs; preserve partial evidence on failure. */
export async function calibrateKitchenSinkResources(options: {
  pluginId: string;
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  sample: () => Promise<GatewayResourceSnapshot>;
  assertDisabled: (payload: unknown) => void;
}): Promise<KitchenSinkCalibration> {
  const result: KitchenSinkCalibration = {
    status: "failed",
    phases: [],
    states: {},
    signals: {},
    postDisposalResidual: {
      status: "unsupported",
      reason: "In-process plugin retirement has not completed",
    },
  };
  const phase = async (name: string, run: () => Promise<void>) => {
    const measured = await measureResourceOperations({
      name,
      count: 1,
      sample: options.sample,
      run,
    });
    result.phases.push(measured);
    assert.equal(measured.status, "exercised", `${name}: ${measured.error}`);
    return measured;
  };
  const state = async (name: string, params: Record<string, unknown>) => {
    const receipt = resourceState(await options.rpc("kitchen.resources", params));
    result.states[name] = receipt;
    return receipt;
  };
  const signal = (name: string, value: number, visible: boolean, expected: string) => {
    result.signals[name] = { status: visible ? "observed" : "inconclusive", value, expected };
  };
  try {
    await phase("control-status", async () => assertReset(await state("initial", {})));
    const cpu = await phase("control-cpu", async () => {
      const receipt = await state("cpu", {
        action: "cpu",
        iterations: KITCHEN_RESOURCE_CONTROLS.iterations,
      });
      assert(receipt.active);
      assert.deepEqual(receipt.lastCpu, {
        iterations: KITCHEN_RESOURCE_CONTROLS.iterations,
        checksum: KITCHEN_RESOURCE_CONTROLS.checksum,
      });
    });
    signal(
      "cpu",
      cpu.cpu!.mainThread.totalMs,
      cpu.cpu!.mainThread.totalMs > 0,
      "positive main-thread CPU with the fixed checksum; includes RPC overhead",
    );
    const buffer = await phase("control-buffer", async () => {
      const receipt = await state("buffer", {
        action: "buffer",
        bytes: KITCHEN_RESOURCE_CONTROLS.bytes,
      });
      assert(receipt.active);
      assert.equal(receipt.bufferBytes, KITCHEN_RESOURCE_CONTROLS.bytes);
    });
    const bufferChange = buffer.memoryChangeBytes!.arrayBuffers!;
    signal(
      "heldBuffer",
      bufferChange,
      bufferChange >= KITCHEN_RESOURCE_CONTROLS.bytes,
      "ArrayBuffer growth at least the held allocation; unrelated collection can obscure it",
    );
    const timer = await phase("control-timer", async () => {
      const receipt = await state("timer", {
        action: "timer",
        intervalMs: KITCHEN_RESOURCE_CONTROLS.intervalMs,
      });
      assert(receipt.active && receipt.timerActive);
      assert.equal(receipt.timerIntervalMs, KITCHEN_RESOURCE_CONTROLS.intervalMs);
      const deadline = performance.now() + 5_000;
      // Poll state, never retry allocation. RPC overhead and probes are part of
      // this one completed control step, not a claimed RPC throughput count.
      while (performance.now() < deadline) {
        const progress = await state("timerProgress", {});
        assert(progress.active && progress.timerActive);
        if (progress.timerTicks > receipt.timerTicks) {
          return;
        }
        await delay(KITCHEN_RESOURCE_CONTROLS.intervalMs);
      }
      throw new Error("Kitchen Sink timer did not advance");
    });
    const timerChange = timer.activeResourceChanges!.Timeout ?? 0;
    signal(
      "referencedTimer",
      timerChange,
      timerChange >= 1,
      "at least one additional Timeout; counts describe resource types, not plugin ownership",
    );
    await phase("control-reset", async () =>
      assertReset(await state("reset", { action: "reset" })),
    );
    // Stop must release held resources. Reset-only stop proof would be vacuous.
    await phase("control-reacquire", async () => {
      const bufferState = await state("stopBuffer", {
        action: "buffer",
        bytes: KITCHEN_RESOURCE_CONTROLS.bytes,
      });
      assert.equal(bufferState.bufferBytes, KITCHEN_RESOURCE_CONTROLS.bytes);
      const timerState = await state("stopTimer", {
        action: "timer",
        intervalMs: KITCHEN_RESOURCE_CONTROLS.intervalMs,
      });
      assert(timerState.active && timerState.timerActive);
      assert.equal(timerState.bufferBytes, KITCHEN_RESOURCE_CONTROLS.bytes);
    });
    const stopped = await phase("plugin-disable", async () => {
      const receipt = await options.rpc("plugins.setEnabled", {
        pluginId: options.pluginId,
        enabled: false,
      });
      result.disableReceipt = receipt;
      assert(
        isRecord(receipt) && receipt.ok === true && receipt.restartRequired === false,
        "disable did not apply in process",
      );
      assert(
        receipt.warnings === undefined ||
          (Array.isArray(receipt.warnings) && receipt.warnings.length === 0),
        "plugin cleanup warned or was deferred",
      );
      const runtime = receipt.runtime;
      assert(
        isRecord(runtime) &&
          typeof runtime.operationId === "string" &&
          runtime.operationId.length > 0 &&
          Number.isSafeInteger(runtime.generation) &&
          Number(runtime.generation) >= 0,
        "disable lacks runtime application receipt",
      );
      assert(
        Array.isArray(runtime.pluginIds) &&
          runtime.pluginIds.every((id) => typeof id === "string") &&
          runtime.pluginIds.includes(options.pluginId),
        "disable receipt misses the fixture",
      );
      result.runtime = runtime as NonNullable<KitchenSinkCalibration["runtime"]>;
      options.assertDisabled(await options.rpc("plugins.list", {}));
    });
    // summarizeResourcePhase rejects a different PID and missing observations.
    const stoppedTimers = stopped.activeResourceChanges!.Timeout ?? 0;
    signal(
      "timerRetirement",
      stoppedTimers,
      stoppedTimers <= -1,
      "at least one fewer Timeout after warning-free retirement; host reload can obscure it",
    );
    result.postDisposalResidual = {
      status: "observed",
      reason:
        "Same-PID snapshots bracket warning-free plugin disable; no forced GC, ownership attribution or leak verdict",
    };
    result.status = "exercised";
  } catch (error) {
    result.error = String(error instanceof Error ? error.message : error).slice(0, 2_048);
  }
  return result;
}
