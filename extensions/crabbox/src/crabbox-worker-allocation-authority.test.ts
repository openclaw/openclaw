import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { operationLeaseId } from "./crabbox-worker-profile.js";
import {
  CHECKPOINT_ID,
  LEASE_ID,
  PROFILE,
  captureWarmImage,
  checkpointResult,
  commandResult,
  createProjectOptions,
  createWarmProvider,
  openWarmImageStore,
  provisionWarmProfile,
} from "./crabbox-worker-warm-image.test-support.js";

describe("Crabbox allocation source authority", () => {
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
          return failure
            ? commandResult({ code: 1, stderr: "checkpoint temporarily unavailable" })
            : checkpointResult(CHECKPOINT_ID, LEASE_ID, "available");
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
      expect(store.lookup(entry.key)?.allocations[operationLeaseId(operationId)]).toBeUndefined();
      expect(store.lookup(entry.key)?.image?.checkpointId).toBe(CHECKPOINT_ID);
    },
  );
});
