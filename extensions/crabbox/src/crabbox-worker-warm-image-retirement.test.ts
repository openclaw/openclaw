import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { crabboxState } from "./crabbox-state.test-support.js";
import { scenario, capacityScenario } from "./crabbox-warm-provider-scenarios.test-support.js";
import {
  closeWarmState,
  firstWarmImage,
  captureOperation,
  pause,
} from "./crabbox-warm-scenarios.test-support.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import { listCrabboxWarmImages } from "./crabbox-worker-warm-image-store.js";
import {
  checkpointResult,
  PROFILE,
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
    const { argv } = call;
    if (argv[2] === "delete" && !catalog.failDeletion) {
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
  let captures = 0;
  let blockDelete = true;
  const s = scenario(async ({ argv }) => {
    if (argv[2] === "create") {
      return checkpointResult(
        `chk_generation_${++captures}`,
        argv[argv.indexOf("--id") + 1]!,
        "available",
      );
    }
    if (argv[2] === "delete" && blockDelete) {
      blockDelete = false;
      await gate.wait();
      if (fails) {
        return commandResult({ code: 7, stderr: "late delete failure" });
      }
    }
    return undefined;
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
    expect(captures).toBe(3);
  } finally {
    gate.release();
  }
  await stopping;
  expect(await firstWarmImage()).toMatchObject({ checkpointId: "chk_generation_3" });
  expect((await firstWarmImage())?.retirement).toBeUndefined();
  expect(s.warn).not.toHaveBeenCalled();
  s.calls.length = 0;
  await s.provision("final-reuse");
  expect(s.checkpoints("fork")[0]?.[3]).toBe("chk_generation_3");
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
