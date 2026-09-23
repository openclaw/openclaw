import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import { crabboxState } from "./crabbox-state.test-support.js";
import {
  openCrabboxWarmImageStore,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";
import {
  createWarmProvider,
  openWarmImageStore,
  provisionWarmProfile,
  tempDirs,
} from "./crabbox-worker-warm-image.test-support.js";

const allocation = {
  machineClass: "standard",
  phase: "pending" as const,
  preparationKey: null,
  cacheKey: null,
  purpose: null,
  demandAtMs: null,
};
const image = {
  checkpointId: "chk_original",
  kind: "native",
  state: "available" as const,
  createdAtMs: 1,
  preparationKey: null,
  cacheKey: null,
  purpose: null,
  lastDemandAtMs: 1,
};

function observeComparisons(before: () => void | Promise<void>, after?: () => void) {
  const open = crabboxState.openKeyedStore;
  let attempts = 0;
  vi.spyOn(crabboxState, "openKeyedStore").mockImplementation(
    <T>(options: OpenAsyncKeyedStoreOptions) => {
      const store = open<T>(options);
      const compareAndApply = store.compareAndApply!;
      return {
        ...store,
        compareAndApply: async (...args: Parameters<typeof compareAndApply>) => {
          attempts += 1;
          if (attempts === 1) {
            await before();
          }
          const result = await compareAndApply(...args);
          after?.();
          return result;
        },
      };
    },
  );
  return () => attempts;
}

describe("Crabbox asynchronous warm-image mutations", () => {
  it("rechecks retirement and preserves sibling allocations after a comparison conflict", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("crabbox-state-conflict-"));
    const fixture = openWarmImageStore();
    fixture.register("profile", { version: 3, image, allocations: {} });
    const attempts = observeComparisons(() => {
      fixture.register("profile", {
        version: 3,
        image,
        operation: { type: "retire", checkpointId: image.checkpointId },
        allocations: {
          sibling: { ...allocation, choice: { kind: "cold" }, imageGeneration: null },
        },
      });
    });
    const store = openCrabboxWarmImageStore(crabboxState);

    const result = await store.recordAllocation({
      key: "profile",
      id: "new",
      allocation,
      availableImage: image,
      assertCurrent() {},
    });

    expect(result.choice).toEqual({ kind: "cold" });
    expect(Object.keys(fixture.lookup("profile")!.allocations).toSorted()).toEqual([
      "new",
      "sibling",
    ]);
    expect(fixture.lookup("profile")!.operation).toEqual({
      type: "retire",
      checkpointId: image.checkpointId,
    });
    expect(attempts()).toBe(2);
  });

  it("discards a capacity rejection when the compared row gained room", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("crabbox-state-capacity-"));
    const fixture = openWarmImageStore();
    const allocations = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [
        `lease-${index}`,
        { ...allocation, choice: { kind: "cold" as const }, imageGeneration: null },
      ]),
    );
    fixture.register("profile", { version: 3, allocations });
    observeComparisons(() => {
      delete allocations["lease-0"];
      fixture.register("profile", { version: 3, allocations });
    });

    await expect(
      openCrabboxWarmImageStore(crabboxState).recordAllocation({
        key: "profile",
        id: "new",
        allocation,
        assertCurrent() {},
      }),
    ).resolves.toMatchObject({ key: "profile", choice: { kind: "cold" } });
    expect(Object.keys(fixture.lookup("profile")!.allocations)).toHaveLength(256);
  });

  it("does not replay a mutation whose completion is unavailable", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("crabbox-state-uncertain-"));
    const attempts = observeComparisons(
      () => {},
      () => {
        throw new Error("fixture completion unavailable");
      },
    );

    await expect(
      openCrabboxWarmImageStore(crabboxState).recordAllocation({
        key: "profile",
        id: "new",
        allocation,
        assertCurrent() {},
      }),
    ).rejects.toThrow("fixture completion unavailable");

    expect(attempts()).toBe(1);
    expect(openWarmImageStore().lookup("profile")?.allocations.new?.choice).toEqual({
      kind: "cold",
    });
  });

  it.each(["removed", "replaced", "conflicting"] as const)(
    "rejects an accepted allocation whose owner is %s before publication",
    async (change) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("crabbox-allocation-publication-"));
      const fixture = openWarmImageStore();
      observeComparisons(
        () => {},
        () => {
          const current = fixture.lookup("profile")!;
          if (change === "removed") {
            fixture.delete("profile");
          } else if (change === "replaced") {
            fixture.register("profile", {
              ...current,
              allocations: { new: { ...current.allocations.new!, phase: "enrolled" } },
            });
          } else {
            fixture.register("conflicting-profile", current);
          }
        },
      );

      await expect(
        openCrabboxWarmImageStore(crabboxState).recordAllocation({
          key: "profile",
          id: "new",
          allocation,
          assertCurrent() {},
        }),
      ).rejects.toThrow(
        change === "conflicting"
          ? "conflicting warm-image owners"
          : "allocation changed before provisioning",
      );
      expect(fixture.lookup("profile")?.allocations.new?.phase).toBe(
        change === "removed" ? undefined : change === "replaced" ? "enrolled" : "pending",
      );
    },
  );

  it.each(["removed", "replaced"] as const)(
    "returns the committed checkpoint projection when its row is subsequently %s",
    async (change) => {
      const { provider } = createWarmProvider();
      const fixture = openWarmImageStore();
      fixture.register("profile", { version: 3, image, allocations: {} });
      observeComparisons(
        () => {},
        () => {
          if (change === "removed") {
            fixture.delete("profile");
          } else {
            fixture.register("profile", {
              version: 3,
              image: { ...image, checkpointId: "chk_replacement" },
              allocations: {},
            });
          }
        },
      );

      await expect(provider.images.pin(image.checkpointId, true)).resolves.toMatchObject({
        profileKey: "profile",
        checkpointId: image.checkpointId,
        pinned: { atMs: expect.any(Number) },
      });
      expect(fixture.lookup("profile")?.image?.checkpointId).toBe(
        change === "removed" ? undefined : "chk_replacement",
      );
    },
  );

  it.each(["profile removed", "allocation removed", "allocation changed"] as const)(
    "refuses replay dispatch when its durable owner is %s before comparison",
    async (change) => {
      const initial = createWarmProvider();
      const lease = await provisionWarmProfile(initial.provider);
      await initial.provider.dispose();
      const fixture = openWarmImageStore();
      const entry = fixture.entries()[0]!;
      observeComparisons(() => {
        if (change === "profile removed") {
          fixture.delete(entry.key);
        } else {
          fixture.register(entry.key, {
            ...entry.value,
            allocations:
              change === "allocation removed"
                ? {}
                : {
                    [lease.leaseId]: {
                      ...entry.value.allocations[lease.leaseId]!,
                      machineClass: "fast",
                    },
                  },
          });
        }
      });
      const restarted = createWarmProvider(undefined, initial.stateDir);

      await expect(provisionWarmProfile(restarted.provider)).rejects.toThrow(
        "allocation changed before provisioning",
      );
      expect(restarted.calls.some(({ argv }) => argv[1] === "warmup" || argv[2] === "fork")).toBe(
        false,
      );
      expect(fixture.lookup(entry.key)?.allocations[lease.leaseId]?.machineClass).toBe(
        change === "allocation changed" ? "fast" : undefined,
      );
    },
  );

  it.each(["pin", "rollback"] as const)(
    "drains an admitted %s write before provider disposal settles",
    async (action) => {
      const { provider } = createWarmProvider();
      const record: WarmProfileRecord = {
        version: 3,
        image,
        previous: { ...image, checkpointId: "chk_previous" },
        allocations: {},
      };
      openWarmImageStore().register("profile", record);
      const admitted = createDeferred<void>();
      const complete = createDeferred<void>();
      observeComparisons(async () => {
        admitted.resolve();
        await complete.promise;
      });
      const mutation =
        action === "pin"
          ? provider.images.pin(image.checkpointId, true)
          : provider.images.rollback("chk_previous");
      await admitted.promise;
      let disposed = false;
      const disposal = provider.dispose().then(() => {
        disposed = true;
      });
      await Promise.resolve();
      expect(disposed).toBe(false);
      complete.resolve();
      await mutation;
      await disposal;
      expect(disposed).toBe(true);
      expect(openWarmImageStore().lookup("profile")?.image).toMatchObject(
        action === "pin"
          ? { pinned: { atMs: expect.any(Number) } }
          : { checkpointId: "chk_previous" },
      );
      await expect(provider.images.pin(image.checkpointId, false)).rejects.toThrow();
    },
  );
});
