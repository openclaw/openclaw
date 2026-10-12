import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { crabboxState, openWarmImageStore } from "./crabbox-state.test-support.js";
import { destroyAndWait, commandResult } from "./crabbox-worker-provider.test-support.js";
import {
  listCrabboxWarmImages,
  recoverCrabboxWarmImageCapture,
} from "./crabbox-worker-warm-image-store.js";
import {
  captureWarmImage,
  checkpointResult,
  createWarmProvider,
  provisionWarmProfile,
  CHECKPOINT_ID,
  LEASE_ID,
  PROFILE,
  type CommandCall,
} from "./crabbox-worker-warm-image.test-support.js";

describe("Crabbox warm-image lifecycle ownership", () => {
  it("replays a cold allocation after restart even after another lease publishes the first image", async () => {
    const initial = createWarmProvider();
    const lease = await provisionWarmProfile(initial.provider, PROFILE, "response-lost");
    await captureWarmImage(initial.provider, PROFILE, "first-template");
    await initial.provider.dispose();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();

    const restarted = createWarmProvider(undefined, initial.stateDir);
    const replay = await provisionWarmProfile(restarted.provider, PROFILE, "response-lost");

    expect(replay.leaseId).toBe(lease.leaseId);
    expect(restarted.calls.some(({ argv }) => argv[1] === "warmup")).toBe(true);
    expect(restarted.calls.some(({ argv }) => argv[2] === "fork")).toBe(false);
  });

  it("pins the original checkpoint through refresh, restart, and an indeterminate stop", async () => {
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
    const initial = createWarmProvider(command);
    await captureWarmImage(initial.provider, PROFILE, "initial-template");
    const lease = await provisionWarmProfile(initial.provider, PROFILE, "response-lost");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 86_400_000);
    await captureWarmImage(initial.provider, PROFILE, "refresh-template");
    expect((await listCrabboxWarmImages(crabboxState))[0]).toMatchObject({
      checkpointId: "chk_generation_2",
      retirement: { checkpointId: "chk_generation_1" },
    });
    expect(initial.calls.some(({ argv }) => argv[2] === "delete")).toBe(false);
    await initial.provider.dispose();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();

    const restarted = createWarmProvider(command, initial.stateDir);
    await provisionWarmProfile(restarted.provider, PROFILE, "response-lost");
    expect(restarted.calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(
      "chk_generation_1",
    );
    stopFails = true;
    await expect(
      restarted.provider.destroy({ leaseId: lease.leaseId, profile: PROFILE }),
    ).rejects.toThrow();
    expect(
      (await listCrabboxWarmImages(crabboxState))[0]?.allocations[lease.leaseId]?.choice,
    ).toEqual({
      kind: "checkpoint",
      checkpointId: "chk_generation_1",
    });
    expect(restarted.calls.some(({ argv }) => argv[2] === "delete")).toBe(false);

    stopFails = false;
    restarted.calls.length = 0;
    await destroyAndWait(restarted.provider, { leaseId: lease.leaseId, profile: PROFILE });
    expect(restarted.calls.findIndex(({ argv }) => argv[1] === "stop")).toBeLessThan(
      restarted.calls.findIndex(({ argv }) => argv[2] === "delete"),
    );
    expect(
      (await listCrabboxWarmImages(crabboxState))[0]?.allocations[lease.leaseId],
    ).toBeUndefined();
    expect((await listCrabboxWarmImages(crabboxState))[0]?.retirement).toBeUndefined();
  });

  it.each(["run"])("retains the old warm image when refresh %s fails", async (action) => {
    let refreshing = false;
    const { provider, calls, warn } = createWarmProvider(({ argv }) =>
      refreshing && (argv[1] === action || argv[2] === action)
        ? commandResult({ code: 7, stderr: "refresh failed" })
        : undefined,
    );
    await captureWarmImage(provider);
    const lease = await provisionWarmProfile(provider);
    const store = openWarmImageStore();
    const [image] = store.entries();
    if (!image) {
      throw new Error("Expected a captured warm image");
    }
    const existing = {
      ...image.value,
      image: { ...image.value.image!, createdAtMs: Date.now() - 24 * 60 * 60 * 1_000 },
    };
    store.register(image.key, existing);
    calls.length = 0;
    refreshing = true;

    await destroyAndWait(provider, { leaseId: lease.leaseId, profile: PROFILE });

    expect(warn).toHaveBeenCalledOnce();
    expect(store.lookup(image.key)?.image).toEqual(existing.image);
    expect((await listCrabboxWarmImages(crabboxState))[0]?.capture?.phase).toBe(
      action === "create" ? "uncertain" : undefined,
    );
    expect(calls.some(({ argv }) => argv[2] === "delete")).toBe(false);
    refreshing = false;
    calls.length = 0;
    await provisionWarmProfile(provider, PROFILE, "after-failed-refresh");
    expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(false);
  });

  it.each([
    { action: "inspect", missing: false, keepPrevious: 0 as const },
    { action: "inspect", missing: true, keepPrevious: 0 as const },
    { action: "fork", missing: false, keepPrevious: 0 as const },
    { action: "fork", missing: false, keepPrevious: 1 as const },
  ])(
    "preserves a refreshed image when an older $action finishes afterward (missing=$missing, keepPrevious=$keepPrevious)",
    async ({ action, missing, keepPrevious }) => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      const commandBlocked = createDeferred<void>();
      const started = createDeferred<void>();
      let blockNext = false;
      let refreshing = false;
      const replacementId = "chk_profile_refreshed";
      const { provider, calls } = createWarmProvider(
        async ({ argv }) => {
          if (blockNext && argv[2] === action) {
            blockNext = false;
            started.resolve();
            await commandBlocked.promise;
            if (missing) {
              return commandResult({
                stdout: JSON.stringify({
                  localState: "available",
                  providerState: "missing",
                  nextAction: "delete",
                }),
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
            refreshAfterMs: 86_400_000,
            retainUnusedMs: 14 * 86_400_000,
            keepPrevious,
          },
        },
      );
      await captureWarmImage(provider);
      const lease = await provisionWarmProfile(provider);
      const store = openWarmImageStore();
      const [image] = store.entries();
      if (!image) {
        throw new Error("Expected a captured warm image");
      }
      store.register(image.key, {
        ...image.value,
        image: {
          ...image.value.image!,
          state: action === "inspect" ? "pending" : "available",
          createdAtMs: Date.now() - 24 * 60 * 60 * 1_000,
          lastDemandAtMs: now - 1_000,
        },
      });
      blockNext = true;
      const provisioning = provisionWarmProfile(
        provider,
        PROFILE,
        `provision:v2:${"1".repeat(64)}`,
      );
      await started.promise;
      refreshing = true;
      try {
        await destroyAndWait(provider, { leaseId: lease.leaseId, profile: PROFILE });
      } finally {
        commandBlocked.resolve();
      }
      await provisioning;

      expect(store.lookup(image.key)?.image?.checkpointId).toBe(replacementId);
      expect(store.lookup(image.key)?.previous?.lastDemandAtMs).toBe(
        keepPrevious ? now : undefined,
      );
      calls.length = 0;
      await provisionWarmProfile(provider, PROFILE, `provision:v2:${"2".repeat(64)}`);
      expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(replacementId);
    },
  );

  it("pauses an abandoned empty reservation after restart until exact acknowledged recovery", async () => {
    const initial = createWarmProvider();
    await captureWarmImage(initial.provider);
    const store = openWarmImageStore();
    const [image] = store.entries();
    if (!image) {
      throw new Error("Expected a captured warm image");
    }
    store.register(image.key, {
      version: 3,
      allocations: {},
      operation: {
        type: "capture",
        id: "migrated-capture",
        phase: "uncertain",
        startedAtMs: Date.now() - 1_200_001,
      },
    });

    const restarted = createWarmProvider(undefined, initial.stateDir);
    await captureWarmImage(restarted.provider);

    expect(restarted.calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(0);
    expect(restarted.calls.some(({ argv }) => argv[2] === "delete")).toBe(false);
    const capture = (await listCrabboxWarmImages(crabboxState))[0]?.capture;
    expect(capture?.stale).toBe(true);
    expect(capture?.leaseId).toBeUndefined();
    await recoverCrabboxWarmImageCapture(crabboxState, capture!.selector, true);
    await captureWarmImage(restarted.provider);
    expect(restarted.calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
    expect(store.lookup(image.key)?.image?.checkpointId).toBe(CHECKPOINT_ID);
  });

  it.each([false, true])(
    "reserves one capture when leases stop concurrently (refresh=%s)",
    async (refresh) => {
      const scrubBlocked = createDeferred<void>();
      let capturing = false;
      const { provider, calls } = createWarmProvider(async ({ argv }) => {
        if (capturing && argv[1] === "run") {
          await scrubBlocked.promise;
        }
        return undefined;
      });
      const first = await provisionWarmProfile(provider);
      const secondOperationId = `provision:v2:${"1".repeat(64)}`;
      const second = await provisionWarmProfile(provider, PROFILE, secondOperationId);
      if (refresh) {
        await captureWarmImage(provider, PROFILE, `provision:v2:${"2".repeat(64)}`);
        const store = openWarmImageStore();
        const [image] = store.entries();
        if (!image) {
          throw new Error("Expected a captured warm image");
        }
        store.register(image.key, {
          ...image.value,
          image: { ...image.value.image!, createdAtMs: Date.now() - 24 * 60 * 60 * 1_000 },
        });
      }
      calls.length = 0;
      capturing = true;

      const firstDestroy = destroyAndWait(provider, { leaseId: first.leaseId, profile: PROFILE });
      await vi.waitFor(() =>
        expect(
          calls.some(
            ({ argv, options }) =>
              argv[1] === "run" && options.input?.toString().includes("CRABBOX_SCRUB_NODE_SCRIPT"),
          ),
        ).toBe(true),
      );
      const secondDestroy = destroyAndWait(provider, { leaseId: second.leaseId, profile: PROFILE });
      await secondDestroy;
      scrubBlocked.resolve();
      await firstDestroy;

      expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
      expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(2);
    },
  );
});
