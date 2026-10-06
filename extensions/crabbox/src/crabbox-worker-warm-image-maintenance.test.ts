import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { openWarmImageStore } from "./crabbox-state.test-support.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import type { WarmProfileRecord } from "./crabbox-worker-warm-image-store.js";
import {
  createWarmProvider,
  managedBinary,
  provisionWarmProfile,
  PROFILE,
} from "./crabbox-worker-warm-image.test-support.js";

const RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const REFRESH_MS = 24 * 60 * 60 * 1_000;
const captureUnsupported = (atMs: number) => ({
  atMs,
  provider: "hetzner",
  message: "Native capture is unsupported by this coordinator",
});
const retainedColdProfile = (atMs: number): WarmProfileRecord => ({
  version: 3,
  captureUnsupported: captureUnsupported(atMs),
  allocations: {
    cbx_retained: {
      choice: { kind: "cold" },
      machineClass: "standard",
      phase: "pending",
      preparationKey: null,
      cacheKey: null,
      purpose: null,
      demandAtMs: null,
      imageGeneration: null,
    },
  },
});
const context = () => ({
  profiles: [PROFILE],
  signal: new AbortController().signal,
  assertCurrent() {},
});
const mixedContext = () => ({
  ...context(),
  profiles: [
    { ...PROFILE, binary: "/opt/b/crabbox" },
    { ...PROFILE, binary: "/opt/a/crabbox" },
    { ...PROFILE, binary: "/opt/a/crabbox" },
  ],
});
const expiredImage = (id: string): WarmProfileRecord => ({
  version: 3,
  allocations: {},
  image: {
    checkpointId: id,
    kind: "aws-ebs-snapshot",
    state: "available",
    createdAtMs: Date.now() - RETENTION_MS,
    preparationKey: null,
    cacheKey: null,
    purpose: null,
    lastDemandAtMs: Date.now() - RETENTION_MS,
  },
});

describe("Crabbox idle image maintenance", () => {
  it.each([REFRESH_MS - 1, REFRESH_MS])(
    "retains a cold-only profile after its last release only while its refusal is active (age=%i)",
    async (age) => {
      const now = 2 * REFRESH_MS;
      vi.spyOn(Date, "now").mockReturnValue(now);
      const { provider, calls } = createWarmProvider();
      const store = openWarmImageStore();
      const record = retainedColdProfile(now - age);
      store.register("retained", record);

      await provider.destroy({
        leaseId: "cbx_retained",
        profile: { ...PROFILE, warmImage: false },
      });

      expect(store.lookup("retained")).toEqual(
        age < REFRESH_MS ? { ...record, allocations: {} } : undefined,
      );
      expect(calls.map(({ argv }) => argv[1])).toEqual(["stop"]);
    },
  );

  it("collects expired marker-only profiles without deleting active markers or allocation owners", async () => {
    const now = 2 * REFRESH_MS;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { provider, calls } = createWarmProvider();
    const store = openWarmImageStore();
    const held = retainedColdProfile(now - REFRESH_MS);
    const active = {
      version: 3 as const,
      allocations: {},
      captureUnsupported: captureUnsupported(now),
    };
    store.register("retained", held);
    store.register("active", active);
    store.register("expired", {
      version: 3,
      allocations: {},
      captureUnsupported: captureUnsupported(now - REFRESH_MS),
    });

    await provider.maintain!(context());

    expect(store.lookup("expired")).toBeUndefined();
    expect(store.lookup("active")).toEqual(active);
    expect(store.lookup("retained")).toEqual(held);
    expect(calls).toEqual([]);
  });

  it.each([
    { fixture: "marker-only", withImage: false },
    { fixture: "image and marker", withImage: true },
  ])(
    "frees a capacity slot held by a retained refusal ($fixture) to admit an allocation",
    async ({ withImage }) => {
      const now = 2 * REFRESH_MS;
      vi.spyOn(Date, "now").mockReturnValue(now);
      const { provider, calls } = createWarmProvider();
      const store = openWarmImageStore();
      for (let index = 0; index < 128; index += 1) {
        store.register(`cold-only-${index}`, {
          version: 3,
          allocations: {},
          captureUnsupported: captureUnsupported(now),
          ...(withImage
            ? {
                image: {
                  ...expiredImage(`chk_refused_${index}`).image!,
                  createdAtMs: now - 3_600_000,
                  lastDemandAtMs: now - 3_600_000,
                },
              }
            : {}),
        });
      }

      const lease = await provisionWarmProfile(provider);

      expect(store.entries()).toHaveLength(128);
      expect(store.entries().filter(({ value }) => value.captureUnsupported)).toHaveLength(127);
      expect(store.entries().some(({ value }) => value.allocations[lease.leaseId])).toBe(true);
      expect(
        calls.filter(({ argv }) => argv[1] === "checkpoint").map(({ argv }) => argv.slice(1)),
      ).toEqual(withImage ? [["checkpoint", "delete", "chk_refused_0"]] : []);
    },
  );

  it("deletes expired images through a healthy binary when another acquisition fails", async () => {
    const { provider, calls, warn } = createWarmProvider();
    vi.spyOn(managedBinary, "ensureManagedCrabboxBinary").mockImplementation(async (params) => {
      if (params?.binary === "/opt/b/crabbox") {
        throw new Error("fixture binary acquisition unavailable");
      }
      return { binary: params?.binary ?? "crabbox", version: "999.0.0" };
    });
    const store = openWarmImageStore();
    store.register("expired", expiredImage("chk_expired"));

    await provider.maintain!(mixedContext());

    expect(calls.map(({ argv }) => argv)).toEqual([
      ["/opt/a/crabbox", "checkpoint", "delete", "chk_expired"],
    ]);
    expect(store.lookup("expired")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("fixture binary acquisition unavailable"),
    );
  });

  it("rejects maintenance and retains images when every binary acquisition fails", async () => {
    const { provider, calls } = createWarmProvider();
    vi.spyOn(managedBinary, "ensureManagedCrabboxBinary").mockRejectedValue(
      new Error("fixture binary acquisition unavailable"),
    );
    const store = openWarmImageStore();
    const expired = expiredImage("chk_expired");
    store.register("expired", expired);

    await expect(provider.maintain!(mixedContext())).rejects.toThrow();

    expect(calls).toEqual([]);
    expect(store.lookup("expired")).toEqual(expired);
  });

  it.each(["creating", "uncertain"] as const)(
    "preserves ownership and pins while reporting an old %s capture",
    async (phase) => {
      const { provider, calls, warn } = createWarmProvider();
      const store = openWarmImageStore();
      const recent = expiredImage("chk_recent");
      recent.image!.lastDemandAtMs = Date.now();
      const pinned = expiredImage("chk_pinned");
      pinned.allocations.cbx_pending = {
        choice: { kind: "checkpoint", checkpointId: "chk_pinned" },
        machineClass: "standard",
        preparationKey: null,
        cacheKey: null,
        purpose: null,
        demandAtMs: null,
        imageGeneration: null,
        phase: "pending",
      };
      const capturing = expiredImage("chk_capturing");
      capturing.operation = {
        type: "capture",
        id: "capture-owner",
        phase,
        startedAtMs: Date.now() - 1_200_000,
      };
      for (const [key, record] of Object.entries({ recent, pinned, capturing })) {
        store.register(key, record);
      }
      store.register("expired", expiredImage("chk_expired"));
      const profile = {
        ...PROFILE,
        setup: "echo configured",
        setupEnv: ["MISSING_MAINTENANCE_SETUP_VALUE"],
        warmImage: false,
      };
      vi.stubEnv("MISSING_MAINTENANCE_SETUP_VALUE", undefined);

      await provider.maintain!({ ...context(), profiles: [profile] });

      expect(calls.map(({ argv }) => argv.slice(1))).toEqual([
        ["checkpoint", "delete", "chk_expired"],
      ]);
      expect(store.lookup("expired")).toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain("capture-owner");
      if (phase === "uncertain") {
        expect(warn.mock.calls[0]?.[0]).toContain("--recover capture-owner");
      } else {
        expect(warn.mock.calls[0]?.[0]).toContain("may still be");
        expect(warn.mock.calls[0]?.[0]).not.toContain("--recover");
        expect(warn.mock.calls[0]?.[0]).not.toContain("Stop the owning Gateway");
        expect(warn.mock.calls[0]?.[0]).not.toContain("failed");
      }
      for (const [key, record] of Object.entries({ recent, pinned, capturing })) {
        expect(store.lookup(key)).toEqual(record);
      }
    },
  );

  it("reports paused captures once per ownership snapshot without attempting capture", async () => {
    const { provider, calls, warn } = createWarmProvider();
    const store = openWarmImageStore();
    const records = Array.from({ length: 4 }, (_, index): WarmProfileRecord => ({
      version: 3,
      allocations: {},
      operation: {
        type: "capture",
        id: `capture-${index}`,
        phase: "uncertain",
        startedAtMs: Date.now() - 1_200_000,
      },
    }));
    records.forEach((record, index) => store.register(`profile-${index}`, record));

    await provider.maintain!(context());
    await provider.maintain!(context());

    expect(warn).toHaveBeenCalledOnce();
    const warning = warn.mock.calls[0]?.[0];
    expect(warning).toContain("4");
    expect(warning).toContain("paused");
    expect(warning).not.toContain("failed");
    expect(warning).toContain("Stop the owning Gateway");
    expect(warning).toContain("--acknowledge-provider-cleanup");
    for (const [index, record] of records.entries()) {
      expect(warning).toContain(`capture-${index}`);
      expect(store.lookup(`profile-${index}`)).toEqual(record);
    }
    expect(calls).toEqual([]);

    store.register("profile-0", {
      version: 3,
      allocations: {},
      operation: {
        type: "capture",
        id: "replacement-capture",
        phase: "uncertain",
        startedAtMs: Date.now(),
      },
    });
    await provider.maintain!(context());
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toContain("replacement-capture");
    records.forEach((_, index) =>
      store.register(`profile-${index}`, { version: 3, allocations: {} }),
    );
    await provider.maintain!(context());
    expect(warn).toHaveBeenCalledTimes(2);
    records.forEach((record, index) => store.register(`profile-${index}`, record));
    await provider.maintain!(context());
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[2]?.[0]).toBe(warning);
    expect(calls).toEqual([]);
  });

  it.each(["dispose", "authority", "operator delete"] as const)(
    "fences %s during deletion and retains its obligation until an active retry",
    async (boundary) => {
      const started = createDeferred<AbortSignal>();
      const finish = createDeferred<void>();
      const { provider, calls, stateDir } = createWarmProvider(async ({ argv, options }) => {
        if (argv[2] !== "delete") {
          return undefined;
        }
        started.resolve(options.signal!);
        await finish.promise;
        return commandResult({ stdout: "checkpoint absent id=chk_expired\n" });
      });
      const store = openWarmImageStore();
      store.register("expired", expiredImage("chk_expired"));
      let current = true;
      const maintenance =
        boundary === "operator delete"
          ? provider.images.delete("chk_expired", mixedContext().profiles)
          : provider.maintain!({
              ...mixedContext(),
              assertCurrent() {
                if (!current) {
                  throw new Error("maintenance authority closed");
                }
              },
            });
      const rejected = expect(maintenance).rejects.toThrow();
      let stopping: Promise<void> | undefined;
      let stopped = false;
      try {
        const signal = await started.promise;
        // Allocation has its own queue and must not wait on the pending deletion.
        await expect(
          provisionWarmProfile(provider, PROFILE, "during-maintenance"),
        ).resolves.toMatchObject({ node: { deviceId: "device-1" } });
        current = false;
        if (boundary !== "authority") {
          stopping = provider.dispose().then(() => {
            stopped = true;
          });
          expect(signal.aborted).toBe(true);
          await Promise.resolve();
          expect(stopped).toBe(false);
        }
      } finally {
        finish.resolve();
        await rejected;
        await stopping;
      }
      expect(store.lookup("expired")?.operation).toEqual({
        type: "retire",
        checkpointId: "chk_expired",
      });
      expect(calls.filter(({ argv }) => argv[2] === "delete").map(({ argv }) => argv)).toEqual([
        ["/opt/a/crabbox", "checkpoint", "delete", "chk_expired"],
      ]);
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      const replacement = createWarmProvider(
        () => commandResult({ stdout: "checkpoint absent id=chk_expired\n" }),
        stateDir,
      );
      await replacement.provider.maintain!(context());
      expect(openWarmImageStore().lookup("expired")).toBeUndefined();
      await replacement.provider.maintain!(context());
      expect(replacement.calls.map(({ argv }) => argv.slice(1))).toEqual([
        ["checkpoint", "delete", "chk_expired"],
      ]);
      if (boundary !== "authority") {
        expect(stopped).toBe(true);
        expect(() => provider.maintain!(context())).toThrow();
        await expect(provider.images.pin("chk_expired", true)).rejects.toThrow();
        await expect(provider.images.rollback("chk_expired")).rejects.toThrow();
        await expect(provider.images.delete("chk_expired", context().profiles)).rejects.toThrow();
      }
    },
  );

  it("deletes retained images across configured catalogs in sorted executable order", async () => {
    const { provider, calls, warn } = createWarmProvider(({ argv }) => {
      const known =
        (argv[0] === "/opt/a/crabbox" && argv[3] === "chk_a") ||
        (argv[0] === "/opt/b/crabbox" && argv[3] === "chk_b");
      return commandResult({
        stdout: `catalog response\n  checkpoint ${known ? "deleted" : "absent"} id=${argv[3]}  \n`,
      });
    });
    const store = openWarmImageStore();
    for (const id of ["chk_a", "chk_b", "chk_nowhere"]) {
      store.register(id, expiredImage(id));
    }

    await provider.maintain!(mixedContext());

    for (const id of ["chk_a", "chk_b", "chk_nowhere"]) {
      expect(store.lookup(id)).toBeUndefined();
      expect(calls.filter(({ argv }) => argv[3] === id).map(({ argv }) => argv)).toEqual(
        (id === "chk_a" ? ["/opt/a/crabbox"] : ["/opt/a/crabbox", "/opt/b/crabbox"]).map(
          (binary) => [binary, "checkpoint", "delete", id],
        ),
      );
    }
    expect(calls).toHaveLength(5);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["exit", "command"])(
    "retains a deletion after a first-executable %s error without consulting another catalog",
    async (failure) => {
      let fails = true;
      const { provider, calls, warn } = createWarmProvider(() => {
        if (!fails) {
          return commandResult({ stdout: "checkpoint absent id=chk_expired\n" });
        }
        if (failure === "command") {
          throw new Error("fixture command unavailable");
        }
        return commandResult({ code: 7, stderr: "fixture deletion unavailable" });
      });
      const store = openWarmImageStore();
      store.register("expired", expiredImage("chk_expired"));

      await provider.maintain!(mixedContext());
      await provider.maintain!(mixedContext());

      expect(store.lookup("expired")?.operation).toEqual({
        type: "retire",
        checkpointId: "chk_expired",
      });
      expect(calls.map(({ argv }) => argv)).toEqual([
        ["/opt/a/crabbox", "checkpoint", "delete", "chk_expired"],
        ["/opt/a/crabbox", "checkpoint", "delete", "chk_expired"],
      ]);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("deletion obligation retained"));
      fails = false;
      calls.length = 0;
      await provider.maintain!(context());
      expect(store.lookup("expired")).toBeUndefined();
      expect(calls.map(({ argv }) => argv.slice(1))).toEqual([
        ["checkpoint", "delete", "chk_expired"],
      ]);
      expect(warn).toHaveBeenCalledOnce();
    },
  );

  it.each([20_000, 60_000])(
    "shares the maintenance deadline after an absent command consumes %i ms",
    async (elapsed) => {
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const { provider, calls, warn } = createWarmProvider(() => {
        now += elapsed;
        return commandResult({ stdout: "checkpoint absent id=chk_expired\n" });
      });
      const store = openWarmImageStore();
      store.register("expired", expiredImage("chk_expired"));
      store.register("expired-cold-only", {
        version: 3,
        allocations: {},
        captureUnsupported: captureUnsupported(now - REFRESH_MS),
      });

      await provider.maintain!(mixedContext());

      expect(calls.map(({ argv, options }) => [argv[0], options.timeoutMs])).toEqual(
        elapsed < 60_000
          ? [
              ["/opt/a/crabbox", 60_000],
              ["/opt/b/crabbox", 40_000],
            ]
          : [["/opt/a/crabbox", 60_000]],
      );
      if (elapsed < 60_000) {
        expect(store.lookup("expired")).toBeUndefined();
        expect(store.lookup("expired-cold-only")).toBeUndefined();
      } else {
        expect(store.lookup("expired")?.operation).toEqual({
          type: "retire",
          checkpointId: "chk_expired",
        });
        expect(store.lookup("expired-cold-only")?.captureUnsupported).toBeDefined();
      }
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("does not confuse another checkpoint's absence with the deletion result", async () => {
    const { provider, calls, warn } = createWarmProvider(() =>
      commandResult({ stdout: "checkpoint absent id=chk_expired_other\n" }),
    );
    const store = openWarmImageStore();
    store.register("expired", expiredImage("chk_expired"));

    await provider.maintain!(mixedContext());

    expect(calls.map(({ argv }) => argv)).toEqual([
      ["/opt/a/crabbox", "checkpoint", "delete", "chk_expired"],
    ]);
    expect(store.lookup("expired")).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
