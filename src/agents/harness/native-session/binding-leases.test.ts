import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as sessionReads from "../../../config/sessions/session-entry-read-runtime.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import { combineNativeSessionBindingAuthority } from "./binding-authority.js";
import { createNativeSessionBindingLeases } from "./binding-leases.js";
import {
  bindingTestOptions,
  createBindingTestState,
  prepareBindingTestLease,
} from "./binding.test-support.js";

function createLeaseFixture() {
  const { state, values } = createBindingTestState();
  const owner = createNativeSessionBindingLeases(state, bindingTestOptions);
  return { state, values, owner };
}

function withLease<T>(
  owner: ReturnType<typeof createLeaseFixture>["owner"],
  key: string,
  run: () => Promise<T>,
) {
  return owner.withLease(key, run, { prepareLease: prepareBindingTestLease });
}

type BindingStore = ReturnType<ReturnType<typeof createBindingTestState>["state"]["withCurrent"]>;

function interceptStore(
  state: ReturnType<typeof createBindingTestState>["state"],
  wrap: (store: BindingStore) => Partial<BindingStore>,
) {
  const withCurrent = state.withCurrent.bind(state);
  state.withCurrent = (authority) => {
    const store = withCurrent(authority);
    return { ...store, ...wrap(store) };
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("native session binding leases", () => {
  it("refuses callback entry when acquisition settles after lease expiry", async () => {
    vi.useFakeTimers();
    const { state, values, owner } = createLeaseFixture();
    interceptStore(state, (store) => ({
      async compareAndApply(...args) {
        const result = await store.compareAndApply(...args);
        if (args[2].action === "set" && args[2].value.lease) {
          vi.setSystemTime(args[2].value.lease.expiresAt);
        }
        return result;
      },
    }));
    const run = vi.fn(async () => "native effect");
    await expect(withLease(owner, "expired", run)).rejects.toThrow("Lost binding lease");
    expect(run).not.toHaveBeenCalled();
    expect(values.get("expired")).not.toHaveProperty("lease");
  });

  it("serializes peer writes behind a renewed binding lease", async () => {
    vi.useFakeTimers();
    const { state, values, owner } = createLeaseFixture();
    const peer = createNativeSessionBindingLeases(state, bindingTestOptions);
    const key = "binding";
    values.set(key, { value: "owner" });
    let peerFinished = false;
    let peerWrite!: Promise<boolean>;
    await expect(
      withLease(owner, key, async () => {
        peerWrite = peer
          .transact(key, () => ({ next: { value: "peer" }, result: true }))
          .then((result) => {
            peerFinished = true;
            return result;
          });
        await Promise.resolve();
        expect(peerFinished).toBe(false);
        await vi.advanceTimersByTimeAsync(66_000);
        expect(peerFinished).toBe(false);
        const updated = await owner.transact(key, (current) => ({
          next: { ...current, value: "updated" },
          result: true,
        }));
        expect(updated).toBe(true);
        await Promise.resolve();
        expect(peerFinished).toBe(false);
        return updated;
      }),
    ).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(peerWrite).resolves.toBe(true);
    expect(values.get(key)).toEqual({ value: "peer" });
  });

  it.each([-70_000, 70_000])(
    "keeps the lease wait deadline on the monotonic clock across a %d ms wall-clock jump",
    async (jumpMs) => {
      vi.useFakeTimers();
      const { values, owner } = createLeaseFixture();
      const key = "binding";
      values.set(key, {
        value: "peer",
        lease: { token: "peer-owner", expiresAt: Date.now() + 120_000 },
      });
      const pending = owner.transact(key, (current) => ({ next: current, result: true }));
      // Observe rejection before advancing timers.
      const settled = pending.then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      vi.setSystemTime(Date.now() + jumpMs);
      if (jumpMs > 0) {
        // Release only after checking the deadline against the forward wall-clock jump.
        await vi.advanceTimersByTimeAsync(1_000);
        values.set(key, { value: "peer" });
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(settled).resolves.toEqual({ ok: true, v: true });
      } else {
        // A wall-clock deadline would take ~140s; the monotonic budget stays at 70s.
        await vi.advanceTimersByTimeAsync(71_000);
        await expect(settled).resolves.toMatchObject({ ok: false });
        await expect(pending).rejects.toThrow("Binding lease timed out: binding");
        vi.clearAllTimers();
      }
    },
  );

  it.each(["transaction", "heartbeat"])(
    "fences a replaced lease at %s without deleting its successor",
    async (check) => {
      vi.useFakeTimers();
      const { state, values, owner } = createLeaseFixture();
      const peer = createNativeSessionBindingLeases(state, bindingTestOptions);
      const key = "binding";
      values.set(key, { value: "owner" });
      await expect(
        withLease(owner, key, async () => {
          if (check === "transaction") {
            vi.setSystemTime(Date.now() + 66_000);
            await peer.withLease(
              key,
              async () => {
                await expect(
                  peer.transact(key, (current) => ({
                    next: { ...current, value: "peer" },
                    result: true,
                  })),
                ).resolves.toBe(true);
              },
              { prepareLease: prepareBindingTestLease },
            );
            await owner.transact(key, () => ({ next: { value: "stale" }, result: true }));
          } else {
            values.set(key, {
              ...values.get(key),
              lease: { token: "peer-owner", expiresAt: Date.now() + 120_000 },
            });
            await vi.advanceTimersByTimeAsync(30_000);
          }
        }),
      ).rejects.toThrow("Lost binding lease");
      if (check === "transaction") {
        expect(values.get(key)).toEqual({ value: "peer" });
      } else {
        expect(values.get(key)?.lease?.token).toBe("peer-owner");
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
    const { promise: ownerStarted, resolve: started } = createDeferred();
    const { promise: finishRun, resolve: finish } = createDeferred();
    let assertRetainedLease!: () => void;
    const expiresAt = Date.now() + bindingTestOptions.lease.staleMs;
    const run = owner
      .withLease(
        bindingKey,
        async () => {
          assertRetainedLease = owner.captureLeaseAssertion(bindingKey);
          failNextObservation = true;
          started();
          await finishRun;
          assertRetainedLease();
        },
        { prepareLease: prepareBindingTestLease },
      )
      .catch((error: unknown) => error);
    await ownerStarted;
    try {
      await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.renewIntervalMs);
      vi.setSystemTime(expiresAt - 1);
      expect(assertRetainedLease).not.toThrow();
      vi.setSystemTime(expiresAt);
    } finally {
      finish();
      await run;
    }
    expect(await run).toBe(renewalFailure);
  });

  it.each(["comparison refusal", "uncertain outcome"])(
    "handles %s without replaying an applied mutation",
    async (outcome) => {
      const { state, values, owner } = createLeaseFixture();
      values.set("binding", { value: "original" });
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
          ? { next: { value: `${current?.value}:once` }, result: true }
          : current?.value === "original"
            ? { next: { value: "updated" }, result: true }
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
    const { state, values, owner } = createLeaseFixture();
    values.set("binding", { value: "original" });
    let holdRenewal = false;
    const { promise: observationReleased, resolve: releaseObservation } = createDeferred();
    interceptStore(state, (store) => ({
      async observe(key) {
        if (holdRenewal) {
          holdRenewal = false;
          await observationReleased;
        }
        return await store.observe(key);
      },
    }));
    const { promise: ownerStarted, resolve: started } = createDeferred();
    const { promise: finishRun, resolve: finish } = createDeferred();
    let settled = false;
    const run = owner
      .withLease(
        "binding",
        async () => {
          holdRenewal = true;
          started();
          await finishRun;
          throw new Error("native request failed");
        },
        { prepareLease: prepareBindingTestLease },
      )
      .then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
    await ownerStarted;
    await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.renewIntervalMs);
    try {
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
    } finally {
      releaseObservation();
      await run;
    }
    expect(await run).toEqual(new Error("native request failed"));
    expect(values.get("binding")).toEqual({ value: "original" });
  });
});

describe("native binding lease settlement", () => {
  it("joins an accepted renewal before quiescing and admits no heartbeat during settlement", async () => {
    vi.useFakeTimers();
    const { state, values, owner } = createLeaseFixture();
    values.set("settling", { value: "original" });
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
    await withLease(owner, "settling", async () => {
      const held = owner.owner("settling")!;
      const originalExpiry = values.get("settling")!.lease!.expiresAt;
      pauseRenewal = true;
      await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.renewIntervalMs);
      await entered.promise;
      try {
        expect(held.renewalPending()).toBe(true);
        expect(() => held.quiesce()).toThrow("Lost binding lease");
        expect(values.get("settling")!.lease!.expiresAt).toBe(originalExpiry);
      } finally {
        released.resolve();
      }
      await held.joinRenewal();
      expect(held.renewalPending()).toBe(false);
      expect(values.get("settling")!.lease!.expiresAt).toBeGreaterThan(originalExpiry);
      held.quiesce();
      const quiesced = structuredClone(values.get("settling"));
      await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.renewIntervalMs * 2);
      expect(values.get("settling")).toEqual(quiesced);
      await expect(
        owner.transact("settling", () => ({ next: { value: "late" }, result: true })),
      ).rejects.toThrow("Lost binding lease");
    });
    expect(values.get("settling")).toEqual({ value: "original" });
  });

  it("retains an uncertain generation after scope exit and lease expiry without replay or release", async () => {
    vi.useFakeTimers();
    const { values, owner } = createLeaseFixture();
    values.set("uncertain", { value: "original" });
    const failure = new SqliteWorkerError("native settlement lost", "outcome-unknown");
    let token: string | undefined;
    await expect(
      withLease(owner, "uncertain", async () => {
        const held = owner.owner("uncertain")!;
        token = held.token;
        held.quiesce();
        held.block(failure, { key: "uncertain", token });
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(values.get("uncertain")?.lease?.token).toBe(token);
    await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.staleMs * 2);
    const replay = vi.fn(async () => "replayed");
    await expect(withLease(owner, "uncertain", replay)).rejects.toBe(failure);
    await expect(
      owner.transact("uncertain", () => ({ next: { value: "replaced" }, result: true })),
    ).rejects.toBe(failure);
    expect(replay).not.toHaveBeenCalled();
    expect(values.get("uncertain")).toMatchObject({ value: "original", lease: { token } });
    await expect(
      owner.withLease("independent", async () => "available", {
        prepareLease: prepareBindingTestLease,
      }),
    ).resolves.toBe("available");
  });

  it("refuses an already-waiting mutation when settlement removes its row", async () => {
    vi.useFakeTimers();
    const { state, values, owner } = createLeaseFixture();
    const key = "queued-before-unknown";
    values.set(key, { value: "original" });
    const entered = createDeferred();
    const finished = createDeferred();
    const waiting = createDeferred();
    let held: ReturnType<typeof owner.owner>;
    const lease = withLease(owner, key, async () => {
      held = owner.owner(key);
      entered.resolve();
      await finished.promise;
    });
    const leaseOutcome = lease.catch((error: unknown) => error);
    await entered.promise;
    interceptStore(state, (store) => ({
      async compareAndApply(...args) {
        const result = await store.compareAndApply(...args);
        if (args[2].action === "keep") {
          waiting.resolve();
        }
        return result;
      },
    }));
    const apply = vi.fn(() => ({ next: { value: "late write" }, result: true }));
    // This caller is outside the lease's async context and has already passed its first fence.
    const mutation = owner.transact(key, apply);
    const mutationOutcome = mutation.catch((error: unknown) => error);
    const failure = new SqliteWorkerError("original deletion outcome unknown", "outcome-unknown");
    try {
      await waiting.promise;
      await vi.advanceTimersByTimeAsync(0);
      held!.block(failure, { key });
      values.delete(key);
      const blockedValue = structuredClone(values.get(key));
      finished.resolve();
      expect(await leaseOutcome).toBe(failure);
      await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.retryIntervalMs);
      expect(await mutationOutcome).toBe(failure);
      expect(apply).not.toHaveBeenCalled();
      expect(values.get(key)).toEqual(blockedValue);
    } finally {
      finished.resolve();
      await leaseOutcome;
      await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.retryIntervalMs);
      await mutationOutcome;
    }
  });

  it("rechecks unresolved custody after observation and immediately before an accepted write", async () => {
    const { state, values, owner } = createLeaseFixture();
    const key = "prepared-before-unknown";
    values.set(key, { value: "original" });
    const entered = createDeferred();
    const released = createDeferred();
    interceptStore(state, (store) => ({
      async compareAndApply(...args) {
        entered.resolve();
        await released.promise;
        return store.compareAndApply(...args);
      },
    }));
    const apply = vi.fn(() => ({ next: { value: "stale prepared write" }, result: true }));
    const mutation = owner.transact(key, apply);
    const outcome = mutation.catch((error: unknown) => error);
    const failure = new SqliteWorkerError("shared participant outcome unknown", "outcome-unknown");
    try {
      await entered.promise;
      expect(apply).toHaveBeenCalledOnce();
      owner.block(key, failure, { key });
      released.resolve();
      expect(await outcome).toBe(failure);
      expect(values.get(key)).toEqual({ value: "original" });
      expect(apply).toHaveBeenCalledOnce();
    } finally {
      released.resolve();
      await outcome;
    }
  });

  it.each(["storage-cleanup", "canceled-after-admission", "canceled-during-run"] as const)(
    "cleans the exact token after %s without borrowing revoked caller authority",
    async (failureAt) => {
      const { state, values } = createBindingTestState();
      const owner = createNativeSessionBindingLeases(state, bindingTestOptions);
      const key = "settlement";
      values.set(key, { value: "native" });
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
      await expect(
        owner.withLease(key, run, {
          prepareLease: prepareBindingTestLease,
          authority: combineNativeSessionBindingAuthority(),
          assertCurrent: () => {
            if (!active) {
              throw failure;
            }
          },
        }),
      ).rejects.toBe(failure);
      expect(run).toHaveBeenCalledTimes(failureAt === "canceled-during-run" ? 1 : 0);
      expect(values.get(key)).toEqual({ value: "native" });
    },
  );

  it("returns an accepted outcome without a new post-effect lineage read", async () => {
    const { state, values } = createBindingTestState();
    const owner = createNativeSessionBindingLeases(state, bindingTestOptions);
    const key = "accepted";
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
      owner.withLease(
        key,
        async () => {
          accepted = true;
          return { accepted: true };
        },
        {
          prepareLease: prepareBindingTestLease,
          authority: combineNativeSessionBindingAuthority(),
        },
      ),
    ).resolves.toEqual({ accepted: true });
    expect(values.get(key)?.lease).toBeUndefined();
  });

  it("does not remove a successor token while settling a revoked caller", async () => {
    const { state, values } = createBindingTestState();
    const owner = createNativeSessionBindingLeases(state, bindingTestOptions);
    const key = "replaced";
    const successor = {
      value: "successor",
      lease: { token: "successor-token", expiresAt: Date.now() + 60_000 },
    };
    const failure = new Error("caller revoked");
    await expect(
      withLease(owner, key, async () => {
        values.set(key, successor);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(values.get(key)).toEqual(successor);
  });
});
