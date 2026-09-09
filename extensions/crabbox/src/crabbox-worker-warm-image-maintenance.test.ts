import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { WarmProfileRecord } from "./crabbox-worker-warm-image-store.js";
import {
  commandResult,
  createWarmProvider,
  openWarmImageStore,
  provisionWarmProfile,
  PROFILE,
} from "./crabbox-worker-warm-image.test-support.js";

const RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
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
  version: 2,
  allocations: {},
  image: {
    checkpointId: id,
    kind: "aws-ebs-snapshot",
    state: "available",
    createdAtMs: Date.now() - RETENTION_MS,
    lastUsedAtMs: Date.now() - RETENTION_MS,
  },
});

describe("Crabbox idle image maintenance", () => {
  it.each(["scrubbing", "creating", "uncertain"] as const)(
    "preserves ownership and pins while reporting an old %s capture",
    async (phase) => {
      const { provider, calls, warn } = createWarmProvider();
      const store = openWarmImageStore();
      const recent = expiredImage("chk_recent");
      recent.image!.lastUsedAtMs = Date.now();
      const pinned = expiredImage("chk_pinned");
      pinned.allocations.cbx_pending = {
        choice: { kind: "checkpoint", checkpointId: "chk_pinned" },
        machineClass: "standard",
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

  it("retains failed deletion for a later idle sweep", async () => {
    let fails = true;
    const { provider, warn } = createWarmProvider(({ argv }) =>
      argv[2] === "delete" && fails
        ? commandResult({ code: 7, stderr: "fixture deletion unavailable" })
        : undefined,
    );
    const store = openWarmImageStore();
    store.register("expired", expiredImage("chk_expired"));
    await provider.maintain!(context());
    expect(store.lookup("expired")?.operation).toEqual({
      type: "retire",
      checkpointId: "chk_expired",
    });
    expect(warn).toHaveBeenCalledOnce();
    fails = false;
    await provider.maintain!(context());
    expect(store.lookup("expired")).toBeUndefined();
  });

  it.each(["dispose", "authority"] as const)(
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
      const maintenance = provider.maintain!({
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
        if (boundary === "dispose") {
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
      const replacement = createWarmProvider(undefined, stateDir);
      await replacement.provider.maintain!(context());
      expect(store.lookup("expired")).toBeUndefined();
      if (boundary === "dispose") {
        expect(stopped).toBe(true);
        expect(() => provider.maintain!(context())).toThrow();
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
      const { provider, calls, warn } = createWarmProvider(() => {
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
      } else {
        expect(store.lookup("expired")?.operation).toEqual({
          type: "retire",
          checkpointId: "chk_expired",
        });
      }
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each(["", "checkpoint absent id=chk_expired_other\n"])(
    "accepts successful deletion without an exact absent line: %j",
    async (stdout) => {
      const { provider, calls, warn } = createWarmProvider(() => commandResult({ stdout }));
      const store = openWarmImageStore();
      store.register("expired", expiredImage("chk_expired"));

      await provider.maintain!(mixedContext());

      expect(calls.map(({ argv }) => argv)).toEqual([
        ["/opt/a/crabbox", "checkpoint", "delete", "chk_expired"],
      ]);
      expect(store.lookup("expired")).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("clears an absent checkpoint after one successful single-executable command", async () => {
    const { provider, calls, warn } = createWarmProvider(() =>
      commandResult({ stdout: "checkpoint absent id=chk_expired\n" }),
    );
    const store = openWarmImageStore();
    store.register("expired", expiredImage("chk_expired"));

    await provider.maintain!(context());

    expect(calls.map(({ argv }) => argv.slice(1))).toEqual([
      ["checkpoint", "delete", "chk_expired"],
    ]);
    expect(store.lookup("expired")).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
