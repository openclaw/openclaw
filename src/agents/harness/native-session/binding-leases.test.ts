import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
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
