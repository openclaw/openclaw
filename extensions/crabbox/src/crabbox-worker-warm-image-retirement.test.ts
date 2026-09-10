import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { operationLeaseId } from "./crabbox-worker-profile.js";
import { listCrabboxWarmImages } from "./crabbox-worker-warm-image-store.js";
import {
  captureWarmImage,
  checkpointResult,
  commandResult,
  createWarmProvider,
  openWarmImageStore,
  provisionWarmProfile,
  PROFILE,
  type CommandCall,
} from "./crabbox-worker-warm-image.test-support.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

describe("Crabbox checkpoint retirement", () => {
  it.each(["held", "capturing", "pinned", "unknown"] as const)(
    "refuses operator deletion of a %s checkpoint before provider calls",
    async (reason) => {
      const { provider, calls } = createWarmProvider();
      await captureWarmImage(provider);
      const store = openWarmImageStore();
      const entry = store.entries()[0]!;
      const checkpointId = entry.value.image!.checkpointId;
      if (reason === "held") {
        await provisionWarmProfile(provider, PROFILE, "held-delete");
      } else if (reason === "capturing") {
        store.update(entry.key, (record) => ({
          ...record!,
          operation: {
            type: "capture",
            id: "capture-test",
            startedAtMs: Date.now(),
            phase: "creating",
          },
        }));
      } else if (reason === "pinned") {
        provider.images.pin(checkpointId, true);
      }
      calls.length = 0;
      await expect(
        provider.images.delete(reason === "unknown" ? "chk_unknown" : checkpointId, [PROFILE]),
      ).rejects.toThrow();
      expect(calls).toEqual([]);
      expect(store.lookup(entry.key)?.image?.checkpointId).toBe(checkpointId);
    },
  );

  it.each([false, true])(
    "retains operator deletion ownership until provider success (failure=%s)",
    async (initialFailure) => {
      let fails = initialFailure;
      const { provider } = createWarmProvider(({ argv }) =>
        fails && argv[2] === "delete"
          ? commandResult({ code: 7, stderr: "unavailable" })
          : undefined,
      );
      await captureWarmImage(provider);
      const checkpointId = listCrabboxWarmImages()[0]!.checkpointId!;
      expect(await provider.images.delete(checkpointId, [PROFILE])).toEqual({
        status: fails ? "retiring" : "deleted",
      });
      if (fails) {
        expect(listCrabboxWarmImages()[0]?.retirement).toEqual({ checkpointId });
        expect(() => provider.images.pin(checkpointId, true)).toThrow("retirement");
        fails = false;
        await provider.maintain!({
          profiles: [PROFILE],
          signal: new AbortController().signal,
          assertCurrent() {},
        });
      }
      expect(listCrabboxWarmImages()).toEqual([]);
    },
  );

  it("preserves pinned checkpoints through unused expiry and full capacity, then expires after unpin", async () => {
    const { provider, calls } = createWarmProvider();
    await captureWarmImage(provider);
    const store = openWarmImageStore();
    const entry = store.entries()[0]!;
    const checkpointId = entry.value.image!.checkpointId;
    provider.images.pin(checkpointId, true);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 15 * DAY_MS);
    const maintenance = {
      profiles: [PROFILE],
      signal: new AbortController().signal,
      assertCurrent() {},
    };
    calls.length = 0;
    await provider.maintain!(maintenance);
    expect(calls).toEqual([]);
    for (let index = 0; index < 127; index++) {
      store.register(`pinned-${index}`, {
        ...entry.value,
        image: {
          ...entry.value.image!,
          checkpointId: `chk_pinned_${index}`,
          pinned: { atMs: Date.now() },
        },
      });
    }
    await expect(
      provisionWarmProfile(provider, { ...PROFILE, class: "fast" }, "full-pins"),
    ).rejects.toThrow("capacity is full");
    expect(store.entries()).toHaveLength(128);
    expect(calls.some(({ argv }) => argv[2] === "delete")).toBe(false);
    provider.images.pin(checkpointId, false);
    await provider.maintain!(maintenance);
    expect(store.lookup(entry.key)).toBeUndefined();
    expect(store.entries()).toHaveLength(127);
  });

  it("reclaims a previous generation before its current image to free a profile slot", async () => {
    const { provider, calls } = createWarmProvider(undefined, undefined, {
      warmImagePolicy: { refreshAfterMs: DAY_MS, retainUnusedMs: 14 * DAY_MS, keepPrevious: 1 },
    });
    await captureWarmImage(provider);
    const store = openWarmImageStore();
    const entry = store.entries()[0]!;
    store.update(entry.key, (record) => ({
      ...record!,
      previous: { ...record!.image!, checkpointId: "chk_previous" },
    }));
    for (let index = 0; index < 127; index++) {
      store.register(`pinned-${index}`, {
        ...entry.value,
        image: {
          ...entry.value.image!,
          checkpointId: `chk_pinned_${index}`,
          pinned: { atMs: Date.now() },
        },
      });
    }
    calls.length = 0;
    await provisionWarmProfile(provider, { ...PROFILE, class: "fast" }, "new-slot");
    expect(calls.filter(({ argv }) => argv[2] === "delete").map(({ argv }) => argv[3])).toEqual([
      "chk_previous",
      entry.value.image!.checkpointId,
    ]);
    expect(store.lookup(entry.key)).toBeUndefined();
    expect(store.entries()).toHaveLength(128);
  });

  it.each([0, 1] as const)(
    "atomically rolls back a previous checkpoint with keepPrevious=%s",
    async (keepPrevious) => {
      const { provider, calls } = createWarmProvider(undefined, undefined, {
        warmImagePolicy: { refreshAfterMs: DAY_MS, retainUnusedMs: 14 * DAY_MS, keepPrevious },
      });
      await captureWarmImage(provider);
      const store = openWarmImageStore();
      const entry = store.entries()[0]!;
      const current = entry.value.image!;
      const previous = {
        ...current,
        checkpointId: "chk_previous",
        createdAtMs: current.createdAtMs - 1,
      };
      store.update(entry.key, (record) => ({ ...record!, previous }));
      const summary = provider.images.rollback(previous.checkpointId);
      expect(summary.checkpointId).toBe(previous.checkpointId);
      expect(summary.previous?.checkpointId).toBe(keepPrevious ? current.checkpointId : undefined);
      expect(summary.retirement?.checkpointId).toBe(
        keepPrevious ? undefined : current.checkpointId,
      );
      calls.length = 0;
      await provider.maintain!({
        profiles: [PROFILE],
        signal: new AbortController().signal,
        assertCurrent() {},
      });
      expect(calls.filter(({ argv }) => argv[2] === "delete").map(({ argv }) => argv[3])).toEqual(
        keepPrevious ? [] : [current.checkpointId],
      );
      expect(store.lookup(entry.key)?.image?.checkpointId).toBe(previous.checkpointId);
    },
  );

  it("keeps a demoted pin after rollback with keepPrevious=0 and expires unused previous after unpin", async () => {
    const { provider } = createWarmProvider();
    await captureWarmImage(provider);
    const store = openWarmImageStore();
    const entry = store.entries()[0]!;
    const current = entry.value.image!;
    provider.images.pin(current.checkpointId, true);
    store.update(entry.key, (record) => ({
      ...record!,
      previous: { ...current, checkpointId: "chk_previous" },
    }));
    expect(provider.images.rollback("chk_previous").previous?.pinned).toBeDefined();
    const maintenance = {
      profiles: [PROFILE],
      signal: new AbortController().signal,
      assertCurrent() {},
    };
    await provider.maintain!(maintenance);
    expect(store.lookup(entry.key)?.previous?.checkpointId).toBe(current.checkpointId);
    provider.images.pin(current.checkpointId, false);
    await provider.maintain!(maintenance);
    expect(store.lookup(entry.key)?.previous).toBeUndefined();
    expect(store.lookup(entry.key)?.image?.checkpointId).toBe("chk_previous");
  });

  it.each(["capture", "retire"] as const)(
    "refuses rollback while a profile owns %s",
    async (type) => {
      const { provider } = createWarmProvider();
      await captureWarmImage(provider);
      const store = openWarmImageStore();
      const entry = store.entries()[0]!;
      store.update(entry.key, (record) => ({
        ...record!,
        previous: { ...record!.image!, checkpointId: "chk_previous" },
        operation:
          type === "capture"
            ? { type, id: "capture-test", startedAtMs: Date.now(), phase: "creating" }
            : { type, checkpointId: "chk_retiring" },
      }));
      const before = store.lookup(entry.key);
      expect(() => provider.images.rollback("chk_previous")).toThrow("capture or retirement");
      expect(store.lookup(entry.key)).toEqual(before);
    },
  );

  it("applies configured unused retention before the default fourteen-day boundary", async () => {
    const { provider } = createWarmProvider(undefined, undefined, {
      warmImagePolicy: { refreshAfterMs: DAY_MS, retainUnusedMs: DAY_MS, keepPrevious: 0 },
    });
    await captureWarmImage(provider);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + DAY_MS);
    await provider.maintain!({
      profiles: [PROFILE],
      signal: new AbortController().signal,
      assertCurrent() {},
    });
    expect(listCrabboxWarmImages()).toEqual([]);
  });
  it.each([
    { debt: "predecessor", profile: PROFILE, allocation: "fork" },
    { debt: "unrelated profile", profile: { ...PROFILE, class: "fast" }, allocation: "warmup" },
    { debt: "current image", profile: PROFILE, allocation: "warmup" },
  ])(
    "allocates via $allocation without awaiting retained $debt deletion after restart",
    async ({ debt, profile, allocation }) => {
      const release = createDeferred<void>();
      let captures = 0;
      let failDeletion = true;
      const resources = new Set<string>();
      const command = async ({ argv }: CommandCall) => {
        if (argv[2] === "create") {
          const id = `chk_capture_${++captures}`;
          resources.add(id);
          return checkpointResult(id, argv[argv.indexOf("--id") + 1]!, "available");
        }
        if (argv[2] === "delete") {
          if (failDeletion) {
            return commandResult({ code: 7, stderr: "provider delete unavailable" });
          }
          await release.promise;
          resources.delete(argv[3]!);
        }
        return undefined;
      };
      const initial = createWarmProvider(command);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      await captureWarmImage(initial.provider);
      clock.mockReturnValue(now + (debt === "current image" ? 15 : 1) * DAY_MS);
      if (debt === "current image") {
        await initial.provider.destroy({
          leaseId: operationLeaseId("retire-current"),
          profile: PROFILE,
        });
      } else {
        await captureWarmImage(initial.provider, PROFILE, "refresh");
      }
      const retained = listCrabboxWarmImages()[0]!;
      expect(retained.retirement?.checkpointId).toBe("chk_capture_1");
      const retainedResources = new Set(resources);
      await initial.provider.dispose();
      resetPluginStateStoreForTests();
      const restarted = createWarmProvider(command, initial.stateDir);
      failDeletion = false;
      const provisioning = provisionWarmProfile(restarted.provider, profile, "during-debt");
      let stopping: Promise<void> | undefined;
      try {
        await vi.waitFor(
          () =>
            expect(
              restarted.calls.some(({ argv }) => argv[1] === allocation || argv[2] === allocation),
            ).toBe(true),
          { timeout: 500 },
        );
        const lease = await provisioning;
        expect(restarted.calls.some(({ argv }) => argv[2] === "delete")).toBe(false);
        expect(restarted.calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(
          allocation === "fork" ? retained.checkpointId : undefined,
        );
        expect(
          listCrabboxWarmImages().find((image) => image.profileKey === retained.profileKey)
            ?.retirement,
        ).toEqual(retained.retirement);
        expect(resources).toEqual(retainedResources);

        stopping = restarted.provider.destroy({ leaseId: lease.leaseId, profile });
        await vi.waitFor(
          () =>
            expect(restarted.calls.find(({ argv }) => argv[2] === "delete")?.argv[3]).toBe(
              "chk_capture_1",
            ),
          { timeout: 500 },
        );
        // Teardown retains ownership until the provider acknowledges deletion.
        expect(
          listCrabboxWarmImages().find((image) => image.profileKey === retained.profileKey)
            ?.retirement,
        ).toEqual(retained.retirement);
        expect(resources).toEqual(retainedResources);
      } finally {
        release.resolve();
        await provisioning;
        await stopping;
      }
      expect(resources.has("chk_capture_1")).toBe(false);
      expect(listCrabboxWarmImages().every((image) => !image.retirement)).toBe(true);
      expect(restarted.calls.at(-1)?.argv[1]).toBe("stop");
    },
  );

  it.each(["expiry", "capacity", "missing"])(
    "retains failed retirement through reuse, restart, deferred refresh, and %s cleanup",
    async (cleanup) => {
      let captures = 0;
      let failDeletion = true;
      let missing = false;
      const resources = new Set<string>();
      const command = ({ argv }: CommandCall) => {
        if (argv[2] === "create") {
          const id = `chk_capture_${++captures}`;
          resources.add(id);
          return checkpointResult(id, argv[argv.indexOf("--id") + 1]!, "completed");
        }
        if (argv[2] === "delete") {
          if (failDeletion) {
            return commandResult({ code: 7, stderr: "provider delete unavailable" });
          }
          resources.delete(argv[3]!);
        }
        if (missing && argv[2] === "inspect") {
          return commandResult({
            stdout: JSON.stringify({
              localState: "available",
              providerState: "missing",
              nextAction: "delete",
            }),
          });
        }
        return undefined;
      };
      const initial = createWarmProvider(command);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      await captureWarmImage(initial.provider);
      clock.mockReturnValue(now + DAY_MS);
      await captureWarmImage(initial.provider, PROFILE, "refresh");
      expect(resources).toEqual(new Set(["chk_capture_1", "chk_capture_2"]));
      await initial.provider.dispose();
      resetPluginStateStoreForTests();
      const restarted = createWarmProvider(command, initial.stateDir);
      clock.mockReturnValue(now + 2 * DAY_MS);
      await captureWarmImage(restarted.provider, PROFILE, "repeat-refresh");
      expect(captures).toBe(2);
      expect(restarted.calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe("chk_capture_2");
      const stop = restarted.calls.findLastIndex(({ argv }) => argv[1] === "stop");
      expect(stop).toBeGreaterThanOrEqual(0);
      expect(restarted.calls.findLastIndex(({ argv }) => argv[2] === "delete")).toBeGreaterThan(
        stop,
      );
      const store = openWarmImageStore();
      const image = store.entries()[0]!;
      if (cleanup === "expiry") {
        clock.mockReturnValue(now + 17 * DAY_MS);
        const lease = { leaseId: operationLeaseId("inspection-only"), profile: PROFILE };
        await restarted.provider.inspect(lease);
        await restarted.provider.destroy(lease);
      } else if (cleanup === "capacity") {
        for (let index = 0; index < 127; index++) {
          store.register(`reserved-${index}`, {
            version: 3,
            allocations: {},
            operation: {
              type: "capture",
              id: `claim-${index}`,
              startedAtMs: now,
              leaseId: `cbx_${index}`,
              provider: "aws",
              phase: "creating",
            },
          });
        }
        await expect(
          provisionWarmProfile(restarted.provider, { ...PROFILE, class: "fast" }, "at-capacity"),
        ).rejects.toThrow("capacity is full");
        expect(store.entries()).toHaveLength(128);
        expect(captures).toBe(2);
      } else {
        // Recheck a pending replacement while its predecessor still needs deletion.
        store.register(image.key, {
          ...store.lookup(image.key)!,
          image: { ...store.lookup(image.key)!.image!, state: "pending" },
        });
        missing = true;
        await captureWarmImage(restarted.provider, PROFILE, "missing-replacement");
        missing = false;
        expect(captures).toBe(2);
      }
      expect(store.lookup(image.key)?.image?.checkpointId).toBe("chk_capture_2");
      expect(
        listCrabboxWarmImages().find((entry) => entry.profileKey === image.key)?.retirement
          ?.checkpointId,
      ).toBe("chk_capture_1");
      expect(resources).toEqual(new Set(["chk_capture_1", "chk_capture_2"]));

      failDeletion = false;
      // An inspection-only teardown retries debt and expiry without capturing a new image.
      await restarted.provider.destroy({
        leaseId: operationLeaseId("cleanup-recovered"),
        profile: PROFILE,
      });
      expect(resources).toEqual(new Set(cleanup === "expiry" ? [] : ["chk_capture_2"]));
      const recovered = await provisionWarmProfile(
        restarted.provider,
        PROFILE,
        "deletion-recovered",
      );
      expect(resources.has("chk_capture_1")).toBe(false);
      if (cleanup !== "expiry") {
        expect(resources).toEqual(new Set(["chk_capture_2"]));
        expect(restarted.calls.findLast(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(
          "chk_capture_2",
        );
      } else {
        expect(resources).toEqual(new Set());
      }
      await restarted.provider.destroy({
        leaseId: recovered.leaseId,
        profile: { ...PROFILE, warmImage: false },
      });
    },
  );

  it.each([false, true])(
    "does not clear or misreport newer state after an older retirement finishes (fails=%s)",
    async (fails) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      let captures = 0;
      let blockDelete = true;
      const { provider, calls, warn } = createWarmProvider(async ({ argv }) => {
        if (argv[2] === "create") {
          return checkpointResult(
            `chk_generation_${++captures}`,
            argv[argv.indexOf("--id") + 1]!,
            "available",
          );
        }
        if (argv[2] === "delete" && blockDelete) {
          blockDelete = false;
          entered.resolve();
          await release.promise;
          if (fails) {
            return commandResult({ code: 7, stderr: "late delete failure" });
          }
        }
        return undefined;
      });
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      await captureWarmImage(provider);
      const lease = await provisionWarmProfile(provider, PROFILE, "first-refresh");
      clock.mockReturnValue(now + DAY_MS);
      const stopping = provider.destroy({ leaseId: lease.leaseId, profile: PROFILE });
      await entered.promise;
      try {
        clock.mockReturnValue(now + 2 * DAY_MS);
        await captureWarmImage(provider, PROFILE, "newer-refresh");
        expect(captures).toBe(3);
      } finally {
        release.resolve();
      }
      await stopping;
      expect(listCrabboxWarmImages()[0]).toMatchObject({ checkpointId: "chk_generation_3" });
      expect(listCrabboxWarmImages()[0]?.retirement).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      calls.length = 0;
      await provisionWarmProfile(provider, PROFILE, "final-reuse");
      expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe("chk_generation_3");
    },
  );
  it.each(["expiry", "capacity", "missing"])(
    "reports retained current-image deletion failures during %s cleanup",
    async (cleanup) => {
      let cleaning = false;
      const { provider, calls, warn } = createWarmProvider(({ argv }) => {
        if (cleaning && argv[2] === "delete" && argv[3] === "chk_profile_warm") {
          return commandResult({ code: 7, stderr: "provider delete unavailable" });
        }
        if (cleaning && cleanup === "missing" && argv[2] === "inspect") {
          return commandResult({
            stdout: JSON.stringify({
              localState: "available",
              providerState: "missing",
              nextAction: "delete",
            }),
          });
        }
        return undefined;
      });
      await captureWarmImage(provider);
      const store = openWarmImageStore();
      const image = store.entries()[0]!;
      const now = Date.now();
      if (cleanup === "capacity") {
        for (let index = 0; index < 127; index++) {
          store.register(`idle-${index}`, {
            ...image.value,
            image: {
              ...image.value.image!,
              checkpointId: `chk_idle_${index}`,
              lastDemandAtMs: now + 1,
            },
          });
        }
      } else if (cleanup === "expiry") {
        vi.spyOn(Date, "now").mockReturnValue(now + 15 * DAY_MS);
      } else {
        store.update(image.key, () => ({
          ...image.value,
          image: { ...image.value.image!, state: "pending" },
        }));
      }
      cleaning = true;
      await captureWarmImage(
        provider,
        cleanup === "capacity" ? { ...PROFILE, class: "fast" } : PROFILE,
        "cleanup",
      );
      expect(store.lookup(image.key)).toMatchObject({
        image: { checkpointId: "chk_profile_warm" },
        operation: { type: "retire", checkpointId: "chk_profile_warm" },
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /checkpoint retirement.*chk_profile_warm.*retained.*retry.*openclaw crabbox warm-images/iu,
        ),
      );
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("warm image capture failed"));
      const stop = calls.findLastIndex(({ argv }) => argv[1] === "stop");
      expect(stop).toBeGreaterThanOrEqual(0);
      if (cleanup !== "capacity") {
        expect(calls.findLastIndex(({ argv }) => argv[2] === "delete")).toBeGreaterThan(stop);
      }
    },
  );
});
