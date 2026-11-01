import { expect, it, vi } from "vitest";
import { crabboxState } from "./crabbox-state.test-support.js";
import { scenario } from "./crabbox-warm-provider-scenarios.test-support.js";
import {
  closeWarmState,
  firstWarmImage,
  updateWarmImage,
  pause,
  captureOperation,
} from "./crabbox-warm-scenarios.test-support.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import { recoverCrabboxWarmImageCapture } from "./crabbox-worker-warm-image-store.js";
import {
  checkpointResult,
  jsonResult,
  createProjectOptions,
  CHECKPOINT_ID,
  LEASE_ID,
  PROFILE,
  type CommandCall,
} from "./crabbox-worker-warm-image.test-support.js";

const day = 86_400_000;
const operationId = (digit: string) => `provision:v2:${digit.repeat(64)}`;
async function restart(s: ReturnType<typeof scenario>, command?: Parameters<typeof scenario>[0]) {
  await closeWarmState(s.provider);
  return scenario(command, s.stateDir);
}

it("renews through capture, then stops before release", async () => {
  vi.useFakeTimers();
  const inspection = pause(),
    capturing = pause();
  let destroying = false;
  let periodicHeartbeatCount = 0;
  let heartbeatSignal: AbortSignal | undefined;
  const s = scenario(async ({ argv, options }) => {
    if (argv[1] === "heartbeat" && argv.includes("--idle-timeout")) {
      periodicHeartbeatCount++;
      heartbeatSignal = options.signal;
    }
    if (destroying && argv[1] === "inspect") {
      await inspection.wait();
    }
    if (destroying && argv[2] === "create") {
      await capturing.wait();
    }
    return undefined;
  });
  let teardown: Promise<void> | undefined;
  try {
    const lease = await s.provision();
    await vi.advanceTimersByTimeAsync(0);
    destroying = true;
    teardown = s.stop(lease);
    void teardown.catch(() => {});
    for (const gate of [inspection, capturing]) {
      const before = periodicHeartbeatCount;
      await gate.entered;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(periodicHeartbeatCount).toBeGreaterThan(before);
      expect(heartbeatSignal?.aborted).toBe(false);
      expect(s.commands("stop")).toEqual([]);
      gate.release();
    }
    await teardown;
    expect(heartbeatSignal?.aborted).toBe(true);
    const afterRelease = periodicHeartbeatCount;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(periodicHeartbeatCount).toBe(afterRelease);
    expect(s.commands("stop")).toHaveLength(1);
  } finally {
    inspection.release();
    capturing.release();
    try {
      await teardown;
    } finally {
      try {
        await s.provider.dispose();
      } finally {
        vi.useRealTimers();
      }
    }
  }
});

it.each(["detected", "devcontainer"] as const)(
  "persists %s failures with correct enrollment",
  async (source) => {
    const events: string[] = [];
    const { options, observe } = createProjectOptions(events);
    const detected = source === "detected";
    const reason = detected ? "npm ci failed" : "onCreateCommand failed";
    const recipePreparation = {
      source,
      ...(detected && { ignoredPropertiesNote: "devcontainer image ignored on cloud machines" }),
      phaseDurationsMs: detected ? { detectedInstall: 75 } : { onCreate: 30 },
      failure: {
        reason,
        outputTail: detected ? "synthetic missing dependency" : "synthetic exit 7",
      },
    };
    options.project.prepare.mockImplementation(async (transport) => {
      if (!detected) {
        await transport.recordRecipePreparation?.(recipePreparation);
        throw new Error(reason);
      }
      return {
        seedKey: "a".repeat(64),
        cacheHit: false,
        captureSkipped: reason,
        recipePreparation,
      };
    });
    const s = scenario(observe);
    const provisioning = s.provision("recipe-failure", PROFILE, options);
    const allocations = detected
      ? { [(await provisioning).leaseId]: { phase: "enrolled", captureSkipped: reason } }
      : {};
    if (!detected) {
      await expect(provisioning).rejects.toThrow(reason);
    }
    expect(events.includes("enrollment-begun")).toBe(detected);
    expect(events).not.toContain("capture");
    if (detected) {
      expect(events).not.toContain("runtime-granted");
    }
    expect(await s.summary()).toMatchObject({
      state: "no-image",
      recipePreparation,
      allocations,
    });
    if (detected) {
      const restarted = await restart(s);
      await restarted.stop(await provisioning);
      expect(restarted.checkpoints("create")).toEqual([]);
      expect(restarted.commands("stop").length).toBeGreaterThan(0);
      expect((await restarted.summary())?.recipePreparation).toEqual(recipePreparation);
    } else {
      expect(s.commands("stop").length).toBeGreaterThan(0);
    }
  },
);

it("replays cold intent after restart and publication", async () => {
  const initial = scenario();
  const lease = await initial.provision("response-lost");
  await initial.capture("first-template");
  const restarted = await restart(initial);
  const replay = await restarted.provision("response-lost");

  expect(replay.leaseId).toBe(lease.leaseId);
  expect(restarted.commands("warmup").length).toBeGreaterThan(0);
  expect(restarted.checkpoints("fork")).toEqual([]);
});

it("pins replay through refresh, restart and failed stop", async () => {
  let captures = 0;
  let stopFails = false;
  const command = ({ argv }: CommandCall) => {
    if (argv[2] === "create") {
      return checkpointResult(
        `chk_generation_${++captures}`,
        argv[argv.indexOf("--id") + 1]!,
        "available",
      );
    }
    if (stopFails && argv[1] === "stop") {
      return commandResult({ code: 7, stderr: "stop unavailable" });
    }
    return undefined;
  };
  const initial = scenario(command);
  await initial.capture("initial-template");
  const lease = await initial.provision("response-lost");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + day);
  await initial.capture("refresh-template");
  expect(await firstWarmImage()).toMatchObject({
    checkpointId: "chk_generation_2",
    retirement: { checkpointId: "chk_generation_1" },
  });
  expect(initial.checkpoints("delete")).toEqual([]);
  const restarted = await restart(initial, command);
  await restarted.provision("response-lost");
  expect(restarted.checkpoints("fork")[0]?.[3]).toBe("chk_generation_1");
  stopFails = true;
  await expect(
    restarted.provider.destroy({ leaseId: lease.leaseId, profile: PROFILE }),
  ).rejects.toThrow();
  expect((await firstWarmImage())?.allocations[lease.leaseId]?.choice).toEqual({
    kind: "checkpoint",
    checkpointId: "chk_generation_1",
  });
  expect(restarted.checkpoints("delete")).toEqual([]);

  stopFails = false;
  restarted.calls.length = 0;
  await restarted.stop(lease);
  expect(restarted.calls.findIndex(({ argv }) => argv[1] === "stop")).toBeLessThan(
    restarted.calls.findIndex(({ argv }) => argv[2] === "delete"),
  );
  const released = await firstWarmImage();
  expect(released?.allocations[lease.leaseId]).toBeUndefined();
  expect(released?.retirement).toBeUndefined();
});

it.each([
  { action: "inspect", missing: false, keepPrevious: 0 as const },
  { action: "inspect", missing: true, keepPrevious: 0 as const },
  { action: "fork", missing: false, keepPrevious: 0 as const },
  { action: "fork", missing: false, keepPrevious: 1 as const },
])(
  "fences old $action (missing=$missing, keep=$keepPrevious)",
  async ({ action, missing, keepPrevious }) => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const gate = pause();
    let blockNext = false;
    let refreshing = false;
    const replacementId = "chk_profile_refreshed";
    const s = scenario(
      async ({ argv }) => {
        if (blockNext && argv[2] === action) {
          blockNext = false;
          await gate.wait();
          if (missing) {
            return jsonResult({
              localState: "available",
              providerState: "missing",
              nextAction: "delete",
            });
          }
        }
        if (refreshing && argv[2] === "create") {
          return checkpointResult(replacementId, LEASE_ID, "available");
        }
        return undefined;
      },
      undefined,
      {
        warmImagePolicy: {
          refreshAfterMs: day,
          retainUnusedMs: 14 * day,
          keepPrevious,
        },
      },
    );
    await s.capture();
    const lease = await s.provision();
    const image = updateWarmImage({
      state: action === "inspect" ? "pending" : "available",
      createdAtMs: now - day,
      lastDemandAtMs: now - 1_000,
    });
    blockNext = true;
    const provisioning = s.provision(operationId("1"));
    await gate.entered;
    refreshing = true;
    await s.stop(lease).finally(gate.release);
    await provisioning;

    expect(s.store.lookup(image.key)?.image?.checkpointId).toBe(replacementId);
    expect(s.store.lookup(image.key)?.previous?.lastDemandAtMs).toBe(
      keepPrevious ? now : undefined,
    );
    s.calls.length = 0;
    await s.provision(operationId("2"));
    expect(s.checkpoints("fork")[0]?.[3]).toBe(replacementId);
  },
);

it("recovers an abandoned empty reservation explicitly", async () => {
  const initial = scenario();
  await initial.capture();
  const image = initial.entry();
  initial.store.register(image.key, {
    version: 3,
    allocations: {},
    operation: captureOperation("migrated-capture", {
      phase: "uncertain",
      startedAtMs: Date.now() - 1_200_001,
    }),
  });

  const restarted = scenario(undefined, initial.stateDir);
  await restarted.capture();

  expect(restarted.checkpoints("create")).toHaveLength(0);
  expect(restarted.checkpoints("delete")).toEqual([]);
  const capture = (await firstWarmImage())?.capture;
  expect({ stale: capture?.stale, leaseId: capture?.leaseId }).toEqual({
    stale: true,
    leaseId: undefined,
  });
  await recoverCrabboxWarmImageCapture(crabboxState, capture!.selector, true);
  await restarted.capture();
  expect(restarted.checkpoints("create")).toHaveLength(1);
  expect(initial.store.lookup(image.key)?.image?.checkpointId).toBe(CHECKPOINT_ID);
});

it.each([false, true])("captures once for concurrent stops (refresh=%s)", async (refresh) => {
  const scrub = pause();
  let capturing = false;
  const s = scenario(async ({ argv }) => {
    if (capturing && argv[1] === "run") {
      await scrub.wait();
    }
    return undefined;
  });
  const first = await s.provision();
  const second = await s.provision(operationId("1"));
  if (refresh) {
    await s.capture(operationId("2"));
    updateWarmImage({ createdAtMs: Date.now() - day });
  }
  s.calls.length = 0;
  capturing = true;

  const firstDestroy = s.stop(first);
  await scrub.entered;
  expect(
    s.calls.some(
      ({ argv, options }) =>
        argv[1] === "run" && options.input?.toString().includes("CRABBOX_SCRUB_NODE_SCRIPT"),
    ),
  ).toBe(true);
  await s.stop(second);
  scrub.release();
  await firstDestroy;

  expect(s.checkpoints("create")).toHaveLength(1);
  expect(s.commands("stop")).toHaveLength(2);
});
