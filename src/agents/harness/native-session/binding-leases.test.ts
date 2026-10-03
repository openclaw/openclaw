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
  return { state, values, owner: createNativeSessionBindingLeases(state, bindingTestOptions) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("native session binding leases", () => {
  it.each(["absent", "renewed"])(
    "serializes peer writes behind a %s binding lease",
    async (mode) => {
      vi.useFakeTimers();
      const { state, values, owner } = createLeaseFixture();
      const peer = createNativeSessionBindingLeases(state, bindingTestOptions);
      const key = "binding";
      if (mode === "renewed") {
        values.set(key, { value: "owner" });
      }
      let peerFinished = false;
      let peerWrite!: Promise<boolean>;
      await expect(
        owner.withLease(
          key,
          async () => {
            peerWrite = peer
              .transact(key, (current) =>
                mode === "renewed" || current?.value === undefined
                  ? { next: { value: "peer" }, result: true }
                  : { result: false },
              )
              .then((result) => {
                peerFinished = true;
                return result;
              });
            await Promise.resolve();
            expect(peerFinished).toBe(false);
            if (mode === "renewed") {
              await vi.advanceTimersByTimeAsync(66_000);
              expect(peerFinished).toBe(false);
            }
            const updated = await owner.transact(key, (current) =>
              mode === "renewed" || current?.value === undefined
                ? {
                    next: { ...current, value: mode === "renewed" ? "updated" : "owner" },
                    result: true,
                  }
                : { result: false },
            );
            expect(updated).toBe(true);
            await Promise.resolve();
            expect(peerFinished).toBe(false);
            return updated;
          },
          { prepareLease: prepareBindingTestLease },
        ),
      ).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(peerWrite).resolves.toBe(mode === "renewed");
      expect(values.get(key)).toEqual({ value: mode === "renewed" ? "peer" : "owner" });
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
        owner.withLease(
          key,
          async () => {
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
          },
          { prepareLease: prepareBindingTestLease },
        ),
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
    const key = "binding-failed-renewal";
    const renewalCause = new Error("renewal observation failed");
    const renewalFailure = new Error(`Lost binding lease: ${key}`, { cause: renewalCause });
    const owner = createNativeSessionBindingLeases(state, {
      ...bindingTestOptions,
      errors: {
        ...bindingTestOptions.errors,
        lostLease: (key, cause) =>
          cause === renewalCause ? renewalFailure : bindingTestOptions.errors.lostLease(key),
      },
    });
    const withCurrent = state.withCurrent.bind(state);
    let failNextObservation = false;
    state.withCurrent = (authority) => {
      const store = withCurrent(authority);
      return {
        ...store,
        async observe(key) {
          if (failNextObservation) {
            failNextObservation = false;
            throw renewalCause;
          }
          return await store.observe(key);
        },
      };
    };
    const { promise: ownerStarted, resolve: started } = createDeferred();
    const { promise: finishRun, resolve: finish } = createDeferred();
    let assertRetainedLease!: () => void;
    const expiresAt = Date.now() + bindingTestOptions.lease.staleMs;
    const run = owner
      .withLease(
        key,
        async () => {
          assertRetainedLease = owner.captureLeaseAssertion(key);
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
      const withCurrent = state.withCurrent.bind(state);
      let replaced = false;
      state.withCurrent = (authority) => {
        const store = withCurrent(authority);
        return {
          ...store,
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
        };
      };
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

  it("reports lease loss even when the callback catches a commit refusal", async () => {
    vi.useFakeTimers();
    const { state, values, owner } = createLeaseFixture();
    values.set("binding", { value: "original" });
    const withCurrent = state.withCurrent.bind(state);
    let expireBeforeAdmission = false;
    state.withCurrent = (authority) => {
      const store = withCurrent(authority);
      return {
        ...store,
        async compareAndApply(...args) {
          if (expireBeforeAdmission) {
            expireBeforeAdmission = false;
            vi.setSystemTime(Date.now() + bindingTestOptions.lease.staleMs + 1);
          }
          return await store.compareAndApply(...args);
        },
      };
    };
    await expect(
      owner.withLease(
        "binding",
        async () => {
          expireBeforeAdmission = true;
          await expect(
            owner.transact("binding", (current) => ({
              next: { ...current, value: "unauthorized" },
              result: true,
            })),
          ).rejects.toThrow("Lost binding lease");
          return "callback completed";
        },
        { prepareLease: prepareBindingTestLease },
      ),
    ).rejects.toThrow("Lost binding lease");
    expect(values.get("binding")).toEqual({ value: "original" });
  });

  it("joins queued renewal before releasing a failed owner", async () => {
    vi.useFakeTimers();
    const { state, values, owner } = createLeaseFixture();
    values.set("binding", { value: "original" });
    const withCurrent = state.withCurrent.bind(state);
    let holdRenewal = false;
    const { promise: observationReleased, resolve: releaseObservation } = createDeferred();
    state.withCurrent = (authority) => {
      const store = withCurrent(authority);
      return {
        ...store,
        async observe(key) {
          if (holdRenewal) {
            holdRenewal = false;
            await observationReleased;
          }
          return await store.observe(key);
        },
      };
    };
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
    const withCurrent = state.withCurrent.bind(state);
    let pauseRenewal = false;
    state.withCurrent = (authority) => {
      const store = withCurrent(authority);
      return {
        ...store,
        async compareAndApply(...args) {
          if (pauseRenewal) {
            pauseRenewal = false;
            entered.resolve();
            await released.promise;
          }
          return store.compareAndApply(...args);
        },
      };
    };
    await owner.withLease(
      "settling",
      async () => {
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
      },
      { prepareLease: prepareBindingTestLease },
    );
    expect(values.get("settling")).toEqual({ value: "original" });
  });

  it("retains an uncertain generation after scope exit and lease expiry without replay or release", async () => {
    vi.useFakeTimers();
    const { values, owner } = createLeaseFixture();
    values.set("uncertain", { value: "original" });
    const failure = new SqliteWorkerError("native settlement lost", "outcome-unknown");
    let token: string | undefined;
    await expect(
      owner.withLease(
        "uncertain",
        async () => {
          const held = owner.owner("uncertain")!;
          token = held.token;
          held.quiesce();
          held.block(failure, { key: "uncertain", token });
          throw failure;
        },
        { prepareLease: prepareBindingTestLease },
      ),
    ).rejects.toBe(failure);
    expect(values.get("uncertain")?.lease?.token).toBe(token);
    await vi.advanceTimersByTimeAsync(bindingTestOptions.lease.staleMs * 2);
    const replay = vi.fn(async () => "replayed");
    await expect(
      owner.withLease("uncertain", replay, { prepareLease: prepareBindingTestLease }),
    ).rejects.toBe(failure);
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

  it.each(["removed row", "expired lease"] as const)(
    "refuses an already-waiting mutation when settlement becomes unknown (%s)",
    async (available) => {
      vi.useFakeTimers();
      const { state, values, owner } = createLeaseFixture();
      const key = "queued-before-unknown";
      values.set(key, { value: "original" });
      const entered = createDeferred();
      const finished = createDeferred();
      const waiting = createDeferred();
      let held: ReturnType<typeof owner.owner>;
      const lease = owner.withLease(
        key,
        async () => {
          held = owner.owner(key);
          entered.resolve();
          await finished.promise;
        },
        { prepareLease: prepareBindingTestLease },
      );
      const leaseOutcome = lease.catch((error: unknown) => error);
      await entered.promise;
      const withCurrent = state.withCurrent.bind(state);
      state.withCurrent = (authority) => {
        const store = withCurrent(authority);
        return {
          ...store,
          async compareAndApply(...args) {
            const result = await store.compareAndApply(...args);
            if (args[2].action === "keep") {
              waiting.resolve();
            }
            return result;
          },
        };
      };
      const apply = vi.fn(() => ({ next: { value: "late write" }, result: true }));
      // This caller is outside the lease's async context and has already passed its first fence.
      const mutation = owner.transact(key, apply);
      const mutationOutcome = mutation.catch((error: unknown) => error);
      const failure = new SqliteWorkerError("original deletion outcome unknown", "outcome-unknown");
      try {
        await waiting.promise;
        await vi.advanceTimersByTimeAsync(0);
        held!.block(failure, { key });
        if (available === "removed row") {
          values.delete(key);
        } else {
          vi.setSystemTime(Date.now() + bindingTestOptions.lease.staleMs + 1);
        }
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
    },
  );

  it("rechecks unresolved custody after observation and immediately before an accepted write", async () => {
    const { state, values, owner } = createLeaseFixture();
    const key = "prepared-before-unknown";
    values.set(key, { value: "original" });
    const entered = createDeferred();
    const released = createDeferred();
    const withCurrent = state.withCurrent.bind(state);
    state.withCurrent = (authority) => {
      const store = withCurrent(authority);
      return {
        ...store,
        async compareAndApply(...args) {
          entered.resolve();
          await released.promise;
          return store.compareAndApply(...args);
        },
      };
    };
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
      const bind = state.withCurrent.bind(state);
      state.withCurrent = (authority) => {
        const store = bind(authority);
        return {
          ...store,
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
        };
      };
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
      owner.withLease(
        key,
        async () => {
          values.set(key, successor);
          throw failure;
        },
        { prepareLease: prepareBindingTestLease },
      ),
    ).rejects.toBe(failure);
    expect(values.get(key)).toEqual(successor);
  });
});
