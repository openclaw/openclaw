import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { operationLeaseId } from "./crabbox-worker-profile.js";
import {
  CHECKPOINT_ID,
  PROFILE,
  captureWarmImage,
  commandResult,
  createProjectOptions,
  createWarmProvider,
  openWarmImageStore,
  provisionWarmProfile,
} from "./crabbox-worker-warm-image.test-support.js";

describe("Crabbox allocation source authority", () => {
  it("rejects the actual prepared callback after its plugin generation stops", async () => {
    const { provider, calls } = createWarmProvider();
    const { options } = createProjectOptions([]);
    const allocate = await provider.prepareProvision!(PROFILE, "retired-generation", options);
    await provider.dispose();
    const before = calls.length;
    await expect(allocate()).rejects.toThrow();
    expect(calls).toHaveLength(before);
    expect(options.project.signal.aborted).toBe(false);
  });

  it.each(["warmup", "inspect", "run"])(
    "does not dispatch forward effects after authority closes during %s",
    async (heldCommand) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const physical = new AbortController();
      const closed = new Error("host invocation closed");
      let current = true;
      let held = false;
      const { provider, calls } = createWarmProvider(async ({ argv }) => {
        if (!held && argv[1] === heldCommand) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return undefined;
      });
      const pending = provisionWarmProfile(
        provider,
        { ...PROFILE, setup: "fixture-setup" },
        "closed-effect",
        undefined,
        {
          signal: physical.signal,
          assertCurrent: () => {
            if (!current) {
              throw closed;
            }
          },
        },
      ).catch((error: unknown) => error);
      let count: number;
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Effect not reached");
          }),
        ]);
        count = calls.length;
        current = false;
      } finally {
        release.resolve();
      }
      expect(await pending).toMatchObject({ code: "cleanup_complete", provisionError: closed });
      expect(physical.signal.aborted).toBe(false);
      expect(
        calls
          .slice(count)
          .filter(({ argv }) => ["warmup", "inspect", "status", "run"].includes(argv[1]!)),
      ).toEqual([]);
      expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(1);
      expect(openWarmImageStore().entries()).toEqual([]);
    },
  );

  it("stops the lease and deletes its unused session snapshot after source closure during enrollment setup", async () => {
    const physical = new AbortController();
    const closed = new Error("enrollment source closed");
    let current = true;
    let captured = false;
    const { options, observe } = createProjectOptions([], physical, {
      key: "a".repeat(64),
      cacheKey: "b".repeat(64),
      purpose: "session",
      demandAtMs: Date.now(),
    });
    const { provider, calls } = createWarmProvider((call) => {
      observe(call);
      captured ||= call.argv[1] === "checkpoint" && call.argv[2] === "create";
      if (
        captured &&
        call.argv[1] === "run" &&
        call.options.input?.toString().includes("CRABBOX_NODE_ENROLLMENT_SCRIPT")
      ) {
        current = false;
      }
      return undefined;
    });
    const operationId = "closed-enrollment-session-snapshot";
    const leaseId = operationLeaseId(operationId);
    const error = await provider
      .provision(PROFILE, operationId, {
        ...options,
        signal: physical.signal,
        assertCurrent: () => {
          if (!current) {
            throw closed;
          }
        },
      })
      .catch((failure: unknown) => failure);
    expect(captured).toBe(true);
    expect(physical.signal.aborted).toBe(false);
    expect(error).toMatchObject({ code: "cleanup_complete", leaseId, provisionError: closed });
    expect(
      calls
        .filter(({ argv }) => argv[1] === "stop")
        .map(({ argv }) => argv[argv.indexOf("--id") + 1]),
    ).toEqual([leaseId]);
    expect(
      calls
        .filter(({ argv }) => argv[1] === "checkpoint" && argv[2] === "delete")
        .map(({ argv }) => argv[3]),
    ).toEqual([CHECKPOINT_ID]);
    expect(openWarmImageStore().entries()).toEqual([]);
    expect(calls.some(({ argv }) => argv[1] === "heartbeat")).toBe(false);
  });

  it.each([
    { outcome: "closed", stopFails: false },
    { outcome: "closed", stopFails: true },
    { outcome: "stop", stopFails: false },
    { outcome: "live", stopFails: false },
  ])(
    "retains cleanup custody for a dispatched fork (outcome=$outcome, stopFails=$stopFails)",
    async ({ outcome, stopFails }) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const physical = new AbortController();
      const closed = new Error("fork source closed");
      const stopped = new DOMException("Explicit Stop", "AbortError");
      const liveLeases = new Set<string>();
      const operationId = "held-checkpoint-fork";
      const leaseId = operationLeaseId(operationId);
      let current = true;
      let observing = false;
      let cleanupFails = stopFails;
      const { provider, calls } = createWarmProvider(async ({ argv, options }) => {
        if (!observing) {
          return undefined;
        }
        if (argv[1] === "checkpoint" && argv[2] === "fork") {
          // Observe the allocating effect, not merely the allocation-choice record.
          liveLeases.add(argv[argv.indexOf("--lease-id") + 1]!);
          entered.resolve();
          await release.promise;
        }
        if (argv[1] === "stop") {
          expect(options.signal).toBeUndefined();
          if (cleanupFails) {
            return commandResult({ code: 5, stderr: "fork teardown pending" });
          }
          liveLeases.delete(argv[argv.indexOf("--id") + 1]!);
        }
        return undefined;
      });
      await captureWarmImage(provider);
      calls.length = 0;
      observing = true;
      const pending = provisionWarmProfile(provider, PROFILE, operationId, undefined, {
        signal: physical.signal,
        assertCurrent: () => {
          if (!current) {
            throw closed;
          }
        },
      }).then(
        (lease) => ({ lease }),
        (error: unknown) => ({ error }),
      );
      let count: number;
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("fork not dispatched");
          }),
        ]);
        expect([...liveLeases]).toEqual([leaseId]);
        count = calls.length;
        if (outcome === "closed") {
          current = false;
        }
        if (outcome === "stop") {
          physical.abort(stopped);
        }
      } finally {
        release.resolve();
      }
      const result = await pending;
      expect(physical.signal.aborted).toBe(outcome === "stop");
      const allocation = openWarmImageStore().entries()[0]?.value.allocations[leaseId];
      if (outcome === "closed") {
        expect(result).toMatchObject({
          error: {
            code: stopFails ? "cleanup_indeterminate" : "cleanup_complete",
            leaseId,
            provisionError: closed,
          },
        });
        expect(calls.slice(count).map(({ argv }) => argv[1])).toEqual(["stop"]);
        expect([...liveLeases]).toEqual(stopFails ? [leaseId] : []);
        if (stopFails) {
          expect(allocation).toBeDefined();
        } else {
          expect(allocation).toBeUndefined();
        }
      } else {
        if (outcome === "stop") {
          expect(result).toEqual({ error: stopped });
          expect(calls).toHaveLength(count);
        } else {
          expect(result).toMatchObject({ lease: { leaseId, node: { deviceId: "device-1" } } });
          expect(allocation?.phase).toBe("enrolled");
        }
        expect([...liveLeases]).toEqual([leaseId]);
        expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
      }
      if (liveLeases.size) {
        cleanupFails = false;
        await provider.destroy({ leaseId, profile: PROFILE });
        expect([...liveLeases]).toEqual([]);
      }
    },
  );

  it.each([false, true])(
    "does not allocate after source closure during checkpoint selection (failure=%s)",
    async (failure) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const physical = new AbortController();
      const closed = new Error("allocation source closed");
      let selecting = false;
      let current = true;
      const { provider, calls } = createWarmProvider(async ({ argv }) => {
        if (selecting && argv[1] === "checkpoint" && argv[2] === "inspect") {
          entered.resolve();
          await release.promise;
          // Success uses the runner's valid checkpoint-inspect receipt, not create output.
          return failure
            ? commandResult({ code: 1, stderr: "checkpoint temporarily unavailable" })
            : undefined;
        }
        return undefined;
      });
      await captureWarmImage(provider);
      const store = openWarmImageStore();
      const [entry] = store.entries();
      if (!entry?.value.image) {
        throw new Error("missing captured image");
      }
      store.update(entry.key, (record) => {
        if (!record?.image) {
          throw new Error("missing image owner");
        }
        return { ...record, image: { ...record.image, state: "pending" } };
      });
      calls.length = 0;
      selecting = true;
      const operationId = "revoked-checkpoint-selection";
      const pending = provisionWarmProfile(provider, PROFILE, operationId, undefined, {
        signal: physical.signal,
        assertCurrent: () => {
          if (!current) {
            throw closed;
          }
        },
      }).then(
        (lease) => ({ lease }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("selection did not wait");
          }),
        ]);
        current = false;
      } finally {
        release.resolve();
      }
      expect(await pending).toEqual({ error: closed });
      expect(physical.signal.aborted).toBe(false);
      expect(
        calls.some(
          ({ argv }) => argv[1] === "warmup" || (argv[1] === "checkpoint" && argv[2] === "fork"),
        ),
      ).toBe(false);
      expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
      expect(store.lookup(entry.key)?.allocations[operationLeaseId(operationId)]).toBeUndefined();
      expect(store.lookup(entry.key)?.image?.checkpointId).toBe(CHECKPOINT_ID);
    },
  );
});
