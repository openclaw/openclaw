import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { expect, it, vi } from "vitest";
import { crabboxState, openWarmImageStore } from "./crabbox-state.test-support.js";
import { scenario, capacityScenario } from "./crabbox-warm-provider-scenarios.test-support.js";
import {
  closeWarmState,
  firstWarmImage,
  captureOperation,
  pause,
  warmImage,
  warmRecord,
  warmStore,
  warmAllocation,
} from "./crabbox-warm-scenarios.test-support.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import type { WarmProfileRecord } from "./crabbox-worker-warm-image-records.js";
import {
  listCrabboxWarmImages,
  openCrabboxWarmImageStore,
} from "./crabbox-worker-warm-image-store.js";
import {
  checkpointResult,
  PROFILE,
  tempDirs,
  type CommandCall,
} from "./crabbox-worker-warm-image.test-support.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const maintenanceContext = () => ({
  profiles: [PROFILE],
  signal: new AbortController().signal,
  assertCurrent() {},
});

async function captured(...args: Parameters<typeof scenario>) {
  const s = scenario(...args);
  await s.capture();
  return s;
}

async function expectDebt(profileKey: string, retirement: unknown) {
  const images = await listCrabboxWarmImages(crabboxState);
  expect(images.find((image) => image.profileKey === profileKey)?.retirement).toEqual(retirement);
}

function checkpointCatalog(state: "available" | "completed" = "available") {
  const catalog = {
    resources: new Set<string>(),
    captures: 0,
    failDeletion: true,
    missing: false,
    command(this: void, { argv }: CommandCall): ReturnType<typeof commandResult> | undefined {
      if (argv[2] === "create") {
        const id = `chk_capture_${++catalog.captures}`;
        catalog.resources.add(id);
        return checkpointResult(id, argv[argv.indexOf("--id") + 1]!, state);
      }
      if (argv[2] === "delete") {
        if (catalog.failDeletion) {
          return commandResult({ code: 7, stderr: "provider delete unavailable" });
        }
        catalog.resources.delete(argv[3]!);
      }
      if (catalog.missing && argv[2] === "inspect") {
        return commandResult({
          stdout: JSON.stringify({
            localState: "available",
            providerState: "missing",
            nextAction: "delete",
          }),
        });
      }
      return undefined;
    },
  };
  return catalog;
}

it.each(["held", "capturing", "pinned", "unknown"] as const)(
  "refuses %s deletion before provider calls",
  async (reason) => {
    const heartbeat = createDeferred<void>();
    const s = await captured(({ argv }) => {
      if (argv[1] === "heartbeat") {
        heartbeat.resolve();
      }
      return undefined;
    });
    const entry = s.entry();
    const checkpointId = entry.value.image!.checkpointId;
    if (reason === "held") {
      await s.provision("held-delete");
      await heartbeat.promise;
    } else if (reason === "capturing") {
      s.store.update(entry.key, (record) => ({
        ...record!,
        operation: captureOperation("capture"),
      }));
    } else if (reason === "pinned") {
      await s.provider.images.pin(checkpointId, true);
    }
    s.calls.length = 0;
    await expect(
      s.provider.images.delete(reason === "unknown" ? "chk_unknown" : checkpointId, [PROFILE]),
    ).rejects.toThrow();
    expect(s.calls).toEqual([]);
    expect(s.store.lookup(entry.key)?.image?.checkpointId).toBe(checkpointId);
  },
);

it.each([false, true])("acknowledges deletion (failure=%s)", async (initialFailure) => {
  let fails = initialFailure;
  const s = await captured(({ argv }) =>
    fails && argv[2] === "delete" ? commandResult({ code: 7, stderr: "unavailable" }) : undefined,
  );
  const checkpointId = (await firstWarmImage())!.checkpointId!;
  expect(await s.provider.images.delete(checkpointId, [PROFILE])).toEqual({
    status: fails ? "retiring" : "deleted",
  });
  if (fails) {
    expect((await firstWarmImage())?.retirement).toEqual({ checkpointId });
    await expect(s.provider.images.pin(checkpointId, true)).rejects.toThrow("retirement");
    fails = false;
    await s.provider.maintain!(maintenanceContext());
  }
  expect(await listCrabboxWarmImages(crabboxState)).toEqual([]);
});

it("rolls back atomically with keepPrevious=0", async () => {
  const s = await captured(undefined, undefined, {
    warmImagePolicy: { refreshAfterMs: DAY_MS, retainUnusedMs: 14 * DAY_MS, keepPrevious: 0 },
  });
  const entry = s.entry();
  const current = entry.value.image!;
  const previous = {
    ...current,
    checkpointId: "chk_previous",
    createdAtMs: current.createdAtMs - 1,
  };
  s.store.update(entry.key, (record) => ({ ...record!, previous }));
  const summary = await s.provider.images.rollback(previous.checkpointId);
  expect(summary.checkpointId).toBe(previous.checkpointId);
  expect(summary.previous?.checkpointId).toBeUndefined();
  expect(summary.retirement?.checkpointId).toBe(current.checkpointId);
  s.calls.length = 0;
  await s.provider.maintain!(maintenanceContext());
  expect(s.checkpoints("delete").map((argv) => argv[3])).toEqual([current.checkpointId]);
  expect(s.store.lookup(entry.key)?.image?.checkpointId).toBe(previous.checkpointId);
});

it("keeps demoted pins until unpinned after rollback", async () => {
  const s = await captured();
  const entry = s.entry();
  const current = entry.value.image!;
  await s.provider.images.pin(current.checkpointId, true);
  s.store.update(entry.key, (record) => ({
    ...record!,
    previous: { ...current, checkpointId: "chk_previous" },
  }));
  expect((await s.provider.images.rollback("chk_previous")).previous?.pinned).toBeDefined();
  const maintenance = maintenanceContext();
  await s.provider.maintain!(maintenance);
  expect(s.store.lookup(entry.key)?.previous?.checkpointId).toBe(current.checkpointId);
  await s.provider.images.pin(current.checkpointId, false);
  await s.provider.maintain!(maintenance);
  expect(s.store.lookup(entry.key)?.previous).toBeUndefined();
  expect(s.store.lookup(entry.key)?.image?.checkpointId).toBe("chk_previous");
});

it("refuses rollback during retirement", async () => {
  const s = await captured();
  const entry = s.entry();
  s.store.update(entry.key, (record) => ({
    ...record!,
    previous: { ...record!.image!, checkpointId: "chk_previous" },
    operation: { type: "retire", checkpointId: "chk_retiring" },
  }));
  const before = s.store.lookup(entry.key);
  await expect(s.provider.images.rollback("chk_previous")).rejects.toThrow("capture or retirement");
  expect(s.store.lookup(entry.key)).toEqual(before);
});

it.each([
  { debt: "predecessor", profile: PROFILE, allocation: "fork" },
  { debt: "unrelated profile", profile: { ...PROFILE, class: "fast" }, allocation: "warmup" },
  { debt: "current image", profile: PROFILE, allocation: "warmup" },
])("allocates despite $debt debt after restart", async ({ debt, profile, allocation }) => {
  const deletion = pause();
  const catalog = checkpointCatalog();
  const { resources } = catalog;
  const command = async (call: CommandCall) => {
    if (call.argv[2] === "delete" && !catalog.failDeletion) {
      await deletion.wait();
    }
    return catalog.command(call);
  };
  const initial = scenario(command);
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  await initial.capture();
  clock.mockReturnValue(now + (debt === "current image" ? 15 : 1) * DAY_MS);
  if (debt === "current image") {
    await initial.provider.maintain!(maintenanceContext());
  } else {
    await initial.capture("refresh");
  }
  const retained = (await firstWarmImage())!;
  expect(retained.retirement?.checkpointId).toBe("chk_capture_1");
  const retainedResources = new Set(resources);
  await closeWarmState(initial.provider);
  const restarted = scenario(command, initial.stateDir);
  catalog.failDeletion = false;
  const provisioning = restarted.provision("during-debt", profile);
  let stopping: Promise<void> | undefined;
  try {
    const lease = await provisioning;
    expect(restarted.checkpoints("delete")).toEqual([]);
    expect(restarted.checkpoints("fork")[0]?.[3]).toBe(
      allocation === "fork" ? retained.checkpointId : undefined,
    );
    await expectDebt(retained.profileKey, retained.retirement);
    expect(resources).toEqual(retainedResources);

    stopping =
      debt === "unrelated profile"
        ? restarted.provider.maintain!(maintenanceContext())
        : restarted.stop(lease, profile);
    await deletion.entered;
    expect(restarted.checkpoints("delete")[0]?.[3]).toBe("chk_capture_1");
    await expectDebt(retained.profileKey, retained.retirement);
    expect(resources).toEqual(retainedResources);
  } finally {
    deletion.release();
    await provisioning;
    await stopping;
  }
  expect(resources.has("chk_capture_1")).toBe(false);
  expect((await listCrabboxWarmImages(crabboxState)).every((image) => !image.retirement)).toBe(
    true,
  );
  if (debt === "unrelated profile") {
    await restarted.stop(await provisioning, profile);
  }
  expect(restarted.calls.at(-1)?.argv[1]).toBe("stop");
});

it.each(["capacity", "missing"])("retries debt after restart (%s)", async (cleanup) => {
  const catalog = checkpointCatalog("completed");
  const { resources } = catalog;
  const initial = scenario(catalog.command);
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  await initial.capture();
  clock.mockReturnValue(now + DAY_MS);
  await initial.capture("refresh");
  expect(resources).toEqual(new Set(["chk_capture_1", "chk_capture_2"]));
  await closeWarmState(initial.provider);
  const restarted = scenario(catalog.command, initial.stateDir);
  clock.mockReturnValue(now + 2 * DAY_MS);
  await restarted.capture("repeat-refresh");
  expect(catalog.captures).toBe(2);
  expect(restarted.checkpoints("fork")[0]?.[3]).toBe("chk_capture_2");
  const stop = restarted.calls.findLastIndex(({ argv }) => argv[1] === "stop");
  expect(stop).toBeGreaterThanOrEqual(0);
  expect(restarted.calls.findLastIndex(({ argv }) => argv[2] === "delete")).toBeGreaterThan(stop);
  const image = restarted.entry();
  if (cleanup === "capacity") {
    for (let index = 0; index < 127; index++) {
      restarted.store.register(`reserved-${index}`, {
        version: 3,
        allocations: {},
        operation: captureOperation(`claim-${index}`, {
          startedAtMs: now,
          leaseId: `cbx_${index}`,
          provider: "aws",
        }),
      });
    }
    await expect(restarted.provision("at-capacity", { ...PROFILE, class: "fast" })).rejects.toThrow(
      "capacity is full",
    );
    expect(restarted.store.entries()).toHaveLength(128);
    expect(catalog.captures).toBe(2);
  } else {
    restarted.store.register(image.key, {
      ...image.value,
      image: { ...image.value.image!, state: "pending" },
    });
    catalog.missing = true;
    await restarted.capture("missing-replacement");
    catalog.missing = false;
    expect(catalog.captures).toBe(2);
  }
  expect(restarted.store.lookup(image.key)?.image?.checkpointId).toBe("chk_capture_2");
  await expectDebt(image.key, { checkpointId: "chk_capture_1" });
  expect(resources).toEqual(new Set(["chk_capture_1", "chk_capture_2"]));

  catalog.failDeletion = false;
  await restarted.provider.maintain!(maintenanceContext());
  expect(resources).toEqual(new Set(["chk_capture_2"]));
  const recovered = await restarted.provision("deletion-recovered");
  expect(resources).toEqual(new Set(["chk_capture_2"]));
  expect(restarted.checkpoints("fork").at(-1)?.[3]).toBe("chk_capture_2");
  await restarted.stop(recovered, { ...PROFILE, warmImage: false });
});

it.each([false, true])("fences old retirement completion (fails=%s)", async (fails) => {
  const gate = pause();
  const catalog = checkpointCatalog();
  catalog.failDeletion = false;
  let blockDelete = true;
  const s = scenario(async (call) => {
    if (call.argv[2] === "delete" && blockDelete) {
      blockDelete = false;
      await gate.wait();
      if (fails) {
        return commandResult({ code: 7, stderr: "late delete failure" });
      }
    }
    return catalog.command(call);
  });
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  await s.capture();
  const lease = await s.provision("first-refresh");
  clock.mockReturnValue(now + DAY_MS);
  const stopping = s.stop(lease);
  await gate.entered;
  try {
    clock.mockReturnValue(now + 2 * DAY_MS);
    await s.capture("newer-refresh");
    expect(catalog.captures).toBe(3);
    // Newer captures report their holders; the stale completion must stay silent.
    s.warn.mockClear();
  } finally {
    gate.release();
  }
  await stopping;
  expect(await firstWarmImage()).toMatchObject({ checkpointId: "chk_capture_3" });
  expect((await firstWarmImage())?.retirement).toBeUndefined();
  expect(s.warn).not.toHaveBeenCalled();
  s.calls.length = 0;
  await s.provision("final-reuse");
  expect(s.checkpoints("fork")[0]?.[3]).toBe("chk_capture_3");
});
it("reports current-image capacity deletion failures", async () => {
  let cleaning = false;
  const { s, image } = await capacityScenario(({ argv }) => {
    if (cleaning && argv[2] === "delete" && argv[3] === "chk_profile_warm") {
      return commandResult({ code: 7, stderr: "provider delete unavailable" });
    }
    return undefined;
  });
  cleaning = true;
  await s.capture("cleanup", { ...PROFILE, class: "fast" });
  expect(s.store.lookup(image.key)).toMatchObject({
    image: { checkpointId: "chk_profile_warm" },
    operation: { type: "retire", checkpointId: "chk_profile_warm" },
  });
  expect(s.warn).toHaveBeenCalledWith(
    expect.stringMatching(
      /checkpoint retirement.*chk_profile_warm.*retained.*retry.*openclaw crabbox warm-images/iu,
    ),
  );
  expect(s.warn).not.toHaveBeenCalledWith(expect.stringContaining("warm image capture failed"));
  const stop = s.calls.findLastIndex(({ argv }) => argv[1] === "stop");
  expect(stop).toBeGreaterThanOrEqual(0);
});

const { choice: _choice, imageGeneration: _generation, ...allocation } = warmAllocation();
const image = warmImage("chk_original");
const retirement = { type: "retire" as const, checkpointId: image.checkpointId };

function stateFixture(profile?: Partial<WarmProfileRecord>) {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("crabbox-store-"));
  const fixture = openWarmImageStore();
  const seed = (record: Partial<WarmProfileRecord>) =>
    fixture.register("profile", warmRecord(record));
  if (profile) {
    seed(profile);
  }
  return {
    fixture,
    seed,
    read: () => fixture.lookup("profile"),
    store: openCrabboxWarmImageStore(crabboxState),
  };
}

function recordAllocation(availableImage?: typeof image) {
  return openCrabboxWarmImageStore(crabboxState).recordAllocation({
    key: "profile",
    id: "new",
    allocation,
    availableImage,
    assertCurrent() {},
  });
}

function observeComparisons(before: () => void | Promise<void>, after?: () => void) {
  const open = crabboxState.openKeyedStoreV2;
  let attempts = 0;
  vi.spyOn(crabboxState, "openKeyedStoreV2").mockImplementation(
    <T>(options: OpenAsyncKeyedStoreOptions) => {
      const store = open<T>(options);
      const compareAndApply = store.compareAndApply;
      store.compareAndApply = async (...args) => {
        if (++attempts === 1) {
          await before();
        }
        const result = await compareAndApply(...args);
        after?.();
        return result;
      };
      return store;
    },
  );
  return () => attempts;
}

it("normalizes diagnostics without migrating v3 records", async () => {
  const { fixture, store } = stateFixture();
  fixture.register("old", warmRecord());
  warmStore<unknown>().register("malformed", {
    version: 3,
    allocations: {},
    recipePreparation: { source: "unknown", commands: ["must not appear"] },
  });
  const recipePreparation = {
    source: "detected" as const,
    phaseDurationsMs: { detectedInstall: 20 },
    failure: { reason: "install failed", outputTail: "☃".repeat(6000) },
  };
  fixture.register("oversized", warmRecord({ recipePreparation }));

  expect(await store.lookup("old")).toEqual({ version: 3, allocations: {} });
  expect((await store.lookup("malformed"))?.recipePreparation).toBeUndefined();
  const diagnostics = (await store.entries()).find(({ key }) => key === "oversized")?.value
    .recipePreparation;
  expect(diagnostics?.phaseDurationsMs).toEqual({ detectedInstall: 20 });
  expect(Buffer.byteLength(diagnostics?.failure?.outputTail ?? "")).toBeLessThanOrEqual(16_384);
  expect(diagnostics?.failure?.outputTail).toMatch(/☃$/u);
});

it("rejects malformed refusals before reading or updating", async () => {
  const { store } = stateFixture();
  const raw = warmStore<unknown>();
  const valid = { atMs: 1, provider: "hetzner", message: "Native capture is unsupported" };
  const malformed = Object.entries({
    atMs: [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"],
    provider: [1, "", "p".repeat(129)],
    message: [1, "", "m".repeat(1025)],
  }).flatMap(([field, values]) => values.map((value) => ({ ...valid, [field]: value })));
  for (const captureUnsupported of [null, ...malformed]) {
    raw.register("profile", { ...warmRecord(), captureUnsupported });

    await expect(store.lookup("profile")).rejects.toThrow("preparation state is invalid");
    const update = vi.fn(() => undefined);
    await expect(store.update("profile", update)).rejects.toThrow("preparation state is invalid");
    expect(update).not.toHaveBeenCalled();
  }
});

it("rechecks retirement and siblings after conflict", async () => {
  const { seed, read } = stateFixture({ image });
  const attempts = observeComparisons(() => {
    seed({
      image,
      operation: retirement,
      allocations: { sibling: warmAllocation() },
    });
  });
  const result = await recordAllocation(image);

  expect(result.choice).toEqual({ kind: "cold" });
  const committed = read()!;
  expect(Object.keys(committed.allocations).toSorted()).toEqual(["new", "sibling"]);
  expect(committed.operation).toEqual(retirement);
  expect(attempts()).toBe(2);
});

it("rechecks capacity after a comparison conflict", async () => {
  const { seed, read } = stateFixture();
  const allocations = Object.fromEntries(
    Array.from({ length: 256 }, (_, index) => [`lease-${index}`, warmAllocation()]),
  );
  seed({ allocations });
  observeComparisons(() => {
    delete allocations["lease-0"];
    seed({ allocations });
  });

  await expect(recordAllocation()).resolves.toMatchObject({
    key: "profile",
    choice: { kind: "cold" },
  });
  expect(Object.keys(read()!.allocations)).toHaveLength(256);
});

it("never replays an indeterminate mutation", async () => {
  const { read } = stateFixture();
  const attempts = observeComparisons(
    () => {},
    () => {
      throw new Error("fixture completion unavailable");
    },
  );

  await expect(recordAllocation()).rejects.toThrow("fixture completion unavailable");

  expect(attempts()).toBe(1);
  expect(read()?.allocations.new?.choice).toEqual({ kind: "cold" });
});

it("returns the committed projection despite replacement", async () => {
  const s = scenario();
  s.store.register("profile", warmRecord({ image }));
  observeComparisons(
    () => {},
    () =>
      s.store.register(
        "profile",
        warmRecord({ image: { ...image, checkpointId: "chk_replacement" } }),
      ),
  );

  await expect(s.provider.images.pin(image.checkpointId, true)).resolves.toMatchObject({
    profileKey: "profile",
    checkpointId: image.checkpointId,
    pinned: { atMs: expect.any(Number) },
  });
  expect(s.store.lookup("profile")?.image?.checkpointId).toBe("chk_replacement");
});

it.each(["profile removed", "allocation removed", "allocation changed"] as const)(
  "refuses dispatch if its owner is %s",
  async (change) => {
    const initial = scenario();
    const lease = await initial.provision();
    await initial.provider.dispose();
    const fixture = initial.store;
    const entry = initial.entry();
    observeComparisons(() => {
      if (change === "profile removed") {
        fixture.delete(entry.key);
      } else {
        const allocations = { ...entry.value.allocations };
        if (change === "allocation removed") {
          delete allocations[lease.leaseId];
        } else {
          allocations[lease.leaseId] = { ...allocations[lease.leaseId]!, machineClass: "fast" };
        }
        fixture.register(entry.key, { ...entry.value, allocations });
      }
    });
    const restarted = scenario(undefined, initial.stateDir);

    await expect(restarted.provision()).rejects.toThrow("allocation changed before provisioning");
    expect(restarted.calls.some(({ argv }) => argv[1] === "warmup")).toBe(false);
    expect(restarted.checkpoints("fork")).toEqual([]);
    expect(fixture.lookup(entry.key)?.allocations[lease.leaseId]?.machineClass).toBe(
      change === "allocation changed" ? "fast" : undefined,
    );
  },
);

it.each(["pin", "rollback"] as const)(
  "drains admitted %s writes before disposal",
  async (action) => {
    const s = scenario();
    s.store.register("profile", warmRecord({ image, previous: warmImage("chk_previous") }));
    const gate = pause();
    observeComparisons(gate.wait);
    const mutation =
      action === "pin"
        ? s.provider.images.pin(image.checkpointId, true)
        : s.provider.images.rollback("chk_previous");
    await gate.entered;
    const disposed = vi.fn();
    const disposal = s.provider.dispose().then(disposed);
    await Promise.resolve();
    expect(disposed).not.toHaveBeenCalled();
    gate.release();
    await mutation;
    await disposal;
    expect(disposed).toHaveBeenCalledOnce();
    expect(s.store.lookup("profile")?.image).toMatchObject(
      action === "pin"
        ? { pinned: { atMs: expect.any(Number) } }
        : { checkpointId: "chk_previous" },
    );
    await expect(s.provider.images.pin(image.checkpointId, false)).rejects.toThrow();
  },
);
