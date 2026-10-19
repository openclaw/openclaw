import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as sessionReads from "../../../config/sessions/session-entry-read-runtime.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import { combineNativeSessionBindingAuthority } from "./binding-authority.js";
import {
  bindingGate,
  bindingMutation,
  interceptBindingStore as interceptStore,
} from "./binding-interleaving.test-support.js";
import { createNativeSessionBindingLeases } from "./binding-leases.js";
import {
  bindingTestOptions,
  createBindingTestState,
  prepareBindingTestLease,
} from "./binding.test-support.js";

const testKey = "binding";

function createLeaseFixture(value?: string, bindingKey = testKey) {
  const { state, values } = createBindingTestState();
  if (value !== undefined) {
    values.set(bindingKey, { value });
  }
  return { state, values, owner: createNativeSessionBindingLeases(state, bindingTestOptions) };
}

function withLease<T>(
  owner: ReturnType<typeof createLeaseFixture>["owner"],
  key: string,
  run: () => Promise<T>,
  options: Omit<Parameters<typeof owner.withLease>[2], "prepareLease"> = {},
) {
  return owner.withLease(key, run, { prepareLease: prepareBindingTestLease, ...options });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("native session binding leases", () => {
  it("serializes peer writes behind a renewed binding lease", async () => {
    vi.useFakeTimers();
    const { state, values, owner } = createLeaseFixture("owner");
    const peer = createNativeSessionBindingLeases(state, bindingTestOptions);
    let peerFinished = false;
    let peerWrite!: Promise<boolean>;
    await expect(
      withLease(owner, testKey, async () => {
        peerWrite = peer
          .transact(testKey, () => bindingMutation("peer"))
          .then((result) => {
            peerFinished = true;
            return result;
          });
        await Promise.resolve();
        expect(peerFinished).toBe(false);
        await vi.advanceTimersByTimeAsync(66_000);
        expect(peerFinished).toBe(false);
        const updated = await owner.transact(testKey, (current) =>
          bindingMutation("updated", current),
        );
        await Promise.resolve();
        expect(peerFinished).toBe(false);
        return updated;
      }),
    ).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(peerWrite).resolves.toBe(true);
    expect(values.get(testKey)).toEqual({ value: "peer" });
  });

  it.each([-70_000, 70_000])(
    "keeps the lease wait deadline on the monotonic clock across a %d ms wall-clock jump",
    async (jumpMs) => {
      vi.useFakeTimers();
      const { values, owner } = createLeaseFixture();
      values.set(testKey, {
        value: "peer",
        lease: { token: "peer-owner", expiresAt: Date.now() + 120_000 },
      });
      const pending = owner.transact(testKey, (current) => ({ next: current, result: true }));
      // Observe rejection before advancing timers.
      const settled = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      vi.setSystemTime(Date.now() + jumpMs);
      if (jumpMs > 0) {
        // Release only after checking the deadline against the forward wall-clock jump.
        await vi.advanceTimersByTimeAsync(1_000);
        values.set(testKey, { value: "peer" });
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(settled).resolves.toBe(true);
      } else {
        // A wall-clock deadline would take ~140s; the monotonic budget stays at 70s.
        await vi.advanceTimersByTimeAsync(71_000);
        await expect(pending).rejects.toThrow("Binding lease timed out: binding");
        vi.clearAllTimers();
      }
    },
  );

  it.each(["transaction", "heartbeat"])(
    "fences a replaced lease at %s without deleting its successor",
    async (check) => {
      vi.useFakeTimers();
      const { state, values, owner } = createLeaseFixture("owner");
      const peer = createNativeSessionBindingLeases(state, bindingTestOptions);
      await expect(
        withLease(owner, testKey, async () => {
          if (check === "transaction") {
            vi.setSystemTime(Date.now() + 66_000);
            await withLease(peer, testKey, async () => {
              await expect(
                peer.transact(testKey, (current) => bindingMutation("peer", current)),
              ).resolves.toBe(true);
            });
            await owner.transact(testKey, () => bindingMutation("stale"));
          } else {
            values.set(testKey, {
              ...values.get(testKey),
              lease: { token: "peer-owner", expiresAt: Date.now() + 120_000 },
            });
            await vi.advanceTimersByTimeAsync(30_000);
          }
        }),
      ).rejects.toThrow("Lost binding lease");
      if (check === "transaction") {
        expect(values.get(testKey)).toEqual({ value: "peer" });
      } else {
        expect(values.get(testKey)?.lease?.token).toBe("peer-owner");
      }
    },
  );

  it("preserves renewal failure after retained cleanup authority expires", async () => {
    vi.useFakeTimers();
    const { state } = createBindingTestState();
    const bindingKey = "binding-failed-renewal";
    const renewalCause = new Error("renewal observation failed");
    const renewalFailure = new Error(`Lost binding lease: ${bindingKey}`, { cause: renewalCause });
    const owner = createNativeSessionBindingLeases(state, {
      ...bindingTestOptions,
      errors: {
        ...bindingTestOptions.errors,
        lostLease: (key, cause) =>
          cause === renewalCause ? renewalFailure : bindingTestOptions.errors.lostLease(key),
      },
    });
    let failNextObservation = false;
    interceptStore(state, (store) => ({
      async observe(key) {
        if (failNextObservation) {
          failNextObservation = false;
          throw renewalCause;
        }
        return await store.observe(key);
      },
    }));
    await using gate = bindingGate();
    let assertRetainedLease!: () => void;
    const expiresAt = Date.now() + bindingTestOptions.lease.staleMs;
    const run = gate.observe(
      withLease(owner, bindingKey, async () => {
        assertRetainedLease = owner.captureLeaseAssertion(bindingKey);
        failNextObservation = true;
        await gate.pause();
        assertRetainedLease();
      }),
    );
    await gate.reached;
    await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.renewIntervalMs);
    vi.setSystemTime(expiresAt - 1);
    expect(assertRetainedLease).not.toThrow();
    vi.setSystemTime(expiresAt);
    gate.resume();
    expect(await run).toBe(renewalFailure);
  });

  it.each(["comparison refusal", "uncertain outcome"])(
    "handles %s without replaying an applied mutation",
    async (outcome) => {
      const { state, values, owner } = createLeaseFixture("original");
      let replaced = false;
      interceptStore(state, (store) => ({
        async compareAndApply(...args) {
          if (outcome === "comparison refusal" && !replaced) {
            replaced = true;
            values.set("binding", { value: "successor" });
          }
          const result = await store.compareAndApply(...args);
          if (outcome === "uncertain outcome") {
            throw new Error("storage outcome unknown");
          }
          return result;
        },
      }));
      const pending = owner.transact("binding", (current) =>
        outcome === "uncertain outcome"
          ? bindingMutation(`${current?.value}:once`)
          : current?.value === "original"
            ? bindingMutation("updated")
            : { result: false },
      );
      if (outcome === "uncertain outcome") {
        await expect(pending).rejects.toThrow("storage outcome unknown");
        expect(values.get("binding")).toEqual({ value: "original:once" });
      } else {
        await expect(pending).resolves.toBe(false);
        expect(values.get("binding")).toEqual({ value: "successor" });
      }
    },
  );

  it("joins queued renewal before releasing a failed owner", async () => {
    vi.useFakeTimers();
    const { state, values, owner } = createLeaseFixture("original");
    let holdRenewal = false;
    await using runGate = bindingGate();
    await using renewalGate = bindingGate();
    interceptStore(state, (store) => ({
      async observe(key) {
        if (holdRenewal) {
          holdRenewal = false;
          await renewalGate.pause();
        }
        return await store.observe(key);
      },
    }));
    let settled = false;
    const run = runGate.observe(
      withLease(owner, "binding", async () => {
        holdRenewal = true;
        await runGate.pause();
        throw new Error("native request failed");
      }).finally(() => {
        settled = true;
      }),
    );
    await runGate.reached;
    await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.renewIntervalMs);
    runGate.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    renewalGate.resume();
    expect(await run).toEqual(new Error("native request failed"));
    expect(values.get("binding")).toEqual({ value: "original" });
  });
  it("joins an accepted renewal before quiescing and admits no heartbeat during settlement", async () => {
    vi.useFakeTimers();
    const { state, values, owner } = createLeaseFixture("original");
    const entered = createDeferred();
    const released = createDeferred();
    let pauseRenewal = false;
    interceptStore(state, (store) => ({
      async compareAndApply(...args) {
        if (pauseRenewal) {
          pauseRenewal = false;
          entered.resolve();
          await released.promise;
        }
        return store.compareAndApply(...args);
      },
    }));
    await withLease(owner, testKey, async () => {
      const held = owner.owner(testKey)!;
      const originalExpiry = values.get(testKey)!.lease!.expiresAt;
      pauseRenewal = true;
      await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.renewIntervalMs);
      await entered.promise;
      try {
        expect(held.renewalPending()).toBe(true);
        expect(() => held.quiesce()).toThrow("Lost binding lease");
        expect(values.get(testKey)!.lease!.expiresAt).toBe(originalExpiry);
      } finally {
        released.resolve();
      }
      await held.joinRenewal();
      expect(held.renewalPending()).toBe(false);
      expect(values.get(testKey)!.lease!.expiresAt).toBeGreaterThan(originalExpiry);
      held.quiesce();
      const quiesced = structuredClone(values.get(testKey));
      await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.renewIntervalMs * 2);
      expect(values.get(testKey)).toEqual(quiesced);
      await expect(owner.transact(testKey, () => bindingMutation("late"))).rejects.toThrow(
        "Lost binding lease",
      );
    });
    expect(values.get(testKey)).toEqual({ value: "original" });
  });

  it("retains an uncertain generation after scope exit and lease expiry without replay or release", async () => {
    vi.useFakeTimers();
    const { values, owner } = createLeaseFixture("original");
    const failure = new SqliteWorkerError("native settlement lost", "outcome-unknown");
    let token: string | undefined;
    await expect(
      withLease(owner, testKey, async () => {
        const held = owner.owner(testKey)!;
        token = held.token;
        held.quiesce();
        held.block(failure, { key: testKey, token });
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(values.get(testKey)?.lease?.token).toBe(token);
    await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.staleMs * 2);
    const replay = vi.fn(async () => "replayed");
    await expect(withLease(owner, testKey, replay)).rejects.toBe(failure);
    await expect(owner.transact(testKey, () => bindingMutation("replaced"))).rejects.toBe(failure);
    expect(replay).not.toHaveBeenCalled();
    expect(values.get(testKey)).toMatchObject({ value: "original", lease: { token } });
    await expect(withLease(owner, "independent", async () => "available")).resolves.toBe(
      "available",
    );
  });

  it.each(["waiting", "prepared"] as const)(
    "refuses a %s mutation when settlement becomes unknown",
    async (phase) => {
      const waiting = phase === "waiting";
      if (waiting) {
        vi.useFakeTimers();
      }
      const { state, values, owner } = createLeaseFixture("original");
      await using leaseGate = bindingGate();
      await using mutationGate = bindingGate();
      const observed = createDeferred();
      let held: ReturnType<typeof owner.owner>;
      const lease = waiting
        ? leaseGate.observe(
            withLease(owner, testKey, async () => {
              held = owner.owner(testKey);
              await leaseGate.pause();
            }),
          )
        : Promise.resolve(undefined);
      if (waiting) {
        await leaseGate.reached;
      }
      interceptStore(state, (store) => ({
        async compareAndApply(...args) {
          if (!waiting) {
            await mutationGate.pause();
          }
          const result = await store.compareAndApply(...args);
          if (args[2].action === "keep") {
            observed.resolve();
          }
          return result;
        },
      }));
      const apply = vi.fn(() => bindingMutation("late write"));
      // Start outside the lease's async context, after its first fence.
      const outcome = mutationGate.observe(owner.transact(testKey, apply));
      const failure = new SqliteWorkerError("settlement outcome unknown", "outcome-unknown");
      try {
        await (waiting ? observed.promise : mutationGate.reached);
        if (waiting) {
          await vi.advanceTimersByTimeAsync(0);
          held!.block(failure, { key: testKey });
          values.delete(testKey);
          leaseGate.resume();
          expect(await lease).toBe(failure);
          await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.retryIntervalMs);
        } else {
          expect(apply).toHaveBeenCalledOnce();
          owner.block(testKey, failure, { key: testKey });
          mutationGate.resume();
        }
        expect(await outcome).toBe(failure);
        expect(apply).toHaveBeenCalledTimes(waiting ? 0 : 1);
        expect(values.get(testKey)).toEqual(waiting ? undefined : { value: "original" });
      } finally {
        leaseGate.resume();
        await lease;
        mutationGate.resume();
        if (waiting) {
          await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.retryIntervalMs);
        }
        await outcome;
      }
    },
  );

  it.each([
    "expired",
    "storage-cleanup",
    "canceled-after-admission",
    "canceled-during-run",
  ] as const)(
    "cleans the exact token after %s without borrowing revoked caller authority",
    async (failureAt) => {
      if (failureAt === "expired") {
        vi.useFakeTimers();
      }
      const { state, values, owner } = createLeaseFixture("native");
      const failure = new Error(failureAt);
      let active = true;
      const run = vi.fn(async () => {
        active = false;
        return "native-outcome";
      });
      interceptStore(state, (store) => ({
        async compareAndApply(...args) {
          const result = await store.compareAndApply(...args);
          if (args[2].action === "set" && args[2].value.lease) {
            if (failureAt === "expired") {
              vi.setSystemTime(args[2].value.lease.expiresAt);
            }
            if (failureAt === "storage-cleanup") {
              throw failure;
            }
            if (failureAt === "canceled-after-admission") {
              active = false;
            }
          }
          return result;
        },
      }));
      const pending = withLease(owner, testKey, run, {
        authority: combineNativeSessionBindingAuthority(),
        assertCurrent: () => {
          if (!active) {
            throw failure;
          }
        },
      });
      if (failureAt === "expired") {
        await expect(pending).rejects.toThrow("Lost binding lease");
      } else {
        await expect(pending).rejects.toBe(failure);
      }
      expect(run).toHaveBeenCalledTimes(failureAt === "canceled-during-run" ? 1 : 0);
      expect(values.get(testKey)).toEqual({ value: "native" });
    },
  );

  it("returns an accepted outcome without a new post-effect lineage read", async () => {
    const { values, owner } = createLeaseFixture();
    const authority = combineNativeSessionBindingAuthority();
    let accepted = false;
    vi.spyOn(sessionReads, "withSessionEntriesFromStoresInWorker").mockImplementation(
      async (_reads, consume) => {
        if (accepted) {
          throw new Error("lineage changed after native acceptance");
        }
        return consume([]);
      },
    );
    await expect(
      withLease(
        owner,
        testKey,
        async () => {
          accepted = true;
          return { accepted: true };
        },
        { authority },
      ),
    ).resolves.toEqual({ accepted: true });
    expect(values.get(testKey)?.lease).toBeUndefined();
  });

  it("does not remove a successor token while settling a revoked caller", async () => {
    const { values, owner } = createLeaseFixture();
    const successor = {
      value: "successor",
      lease: { token: "successor-token", expiresAt: Date.now() + 60_000 },
    };
    const failure = new Error("caller revoked");
    await expect(
      withLease(owner, testKey, async () => {
        values.set(testKey, successor);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(values.get(testKey)).toEqual(successor);
  });
});
