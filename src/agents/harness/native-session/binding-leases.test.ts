import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeSessionBindingLeases } from "./binding-leases.js";
import {
  bindingTestOptions,
  createBindingTestState,
  prepareBindingTestLease,
} from "./binding.test-support.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("native session binding leases", () => {
  it("serializes writes from another facade behind a native-compaction lease", async () => {
    vi.useFakeTimers();
    const { state, values } = createBindingTestState();
    const owner = createNativeSessionBindingLeases(state, bindingTestOptions);
    const peer = createNativeSessionBindingLeases(state, bindingTestOptions);
    const key = "binding-1";
    values.set(key, { value: "owner" });
    let peerFinished = false;
    let peerWrite!: Promise<boolean>;

    await owner.withLease(key, async () => {
      peerWrite = peer.transact(key, () => ({ next: { value: "peer" }, result: true }))
        .then((result) => {
          peerFinished = true;
          return result;
        });
      await Promise.resolve();
      expect(peerFinished).toBe(false);
    }, { prepareLease: prepareBindingTestLease });
    await vi.advanceTimersByTimeAsync(1_000);
    await peerWrite;

    expect(values.get(key)).toEqual({ value: "peer" });
  });

  it("leases an absent binding before creating its first native owner", async () => {
    vi.useFakeTimers();
    const { state, values } = createBindingTestState();
    const owner = createNativeSessionBindingLeases(state, bindingTestOptions);
    const peer = createNativeSessionBindingLeases(state, bindingTestOptions);
    const key = "binding-new";
    let peerFinished = false;
    let peerWrite!: Promise<boolean>;

    await owner.withLease(key, async () => {
      peerWrite = peer.transact(key, (current) => current?.value === undefined
        ? { next: { value: "peer" }, result: true }
        : { result: false }).then((result) => {
          peerFinished = true;
          return result;
        });
      await Promise.resolve();
      expect(peerFinished).toBe(false);
      await expect(owner.transact(key, (current) => current?.value === undefined
        ? { next: { ...current, value: "owner" }, result: true }
        : { result: false })).resolves.toBe(true);
      await Promise.resolve();
      expect(peerFinished).toBe(false);
    }, { prepareLease: prepareBindingTestLease });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(peerWrite).resolves.toBe(false);
    expect(values.get(key)).toEqual({ value: "owner" });
  });

  it("releases a lease when its owner callback rejects", async () => {
    const { state, values } = createBindingTestState();
    const owner = createNativeSessionBindingLeases(state, bindingTestOptions);
    const peer = createNativeSessionBindingLeases(state, bindingTestOptions);
    const key = "binding-rejected-owner";
    values.set(key, { value: "owner" });

    await expect(owner.withLease(key, async () => {
      throw new Error("owner failed");
    }, { prepareLease: prepareBindingTestLease })).rejects.toThrow("owner failed");
    await expect(peer.transact(key, (current) => ({
      next: { ...current, value: "updated" }, result: true,
    }))).resolves.toBe(true);
  });

  it("renews a live lease across a long native request", async () => {
    vi.useFakeTimers();
    const { state, values } = createBindingTestState();
    const owner = createNativeSessionBindingLeases(state, bindingTestOptions);
    const peer = createNativeSessionBindingLeases(state, bindingTestOptions);
    const key = "binding-renewed-owner";
    values.set(key, { value: "owner" });
    let releaseOwner!: () => void;
    let markOwnerStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => { markOwnerStarted = resolve; });
    const holdOwner = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const ownerRun = owner.withLease(key, async () => {
      markOwnerStarted();
      await holdOwner;
      return await owner.transact(key, (current) => ({
        next: { ...current, value: "updated" }, result: true,
      }));
    }, { prepareLease: prepareBindingTestLease });
    await ownerStarted;
    let peerFinished = false;
    const peerWrite = peer.transact(key, () => ({ next: { value: "peer" }, result: true }))
      .then((result) => {
        peerFinished = true;
        return result;
      });

    await vi.advanceTimersByTimeAsync(66_000);
    expect(peerFinished).toBe(false);
    releaseOwner();
    await expect(ownerRun).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(peerWrite).resolves.toBe(true);
    expect(values.get(key)).toEqual({ value: "peer" });
  });

  it("fences an expired lease owner after a peer takes over", async () => {
    vi.useFakeTimers();
    const { state, values } = createBindingTestState();
    const owner = createNativeSessionBindingLeases(state, bindingTestOptions);
    const peer = createNativeSessionBindingLeases(state, bindingTestOptions);
    const key = "binding-stale-owner";
    values.set(key, { value: "owner" });

    await expect(owner.withLease(key, async () => {
      vi.setSystemTime(Date.now() + 66_000);
      await peer.withLease(key, async () => {
        await expect(peer.transact(key, (current) => ({
          next: { ...current, value: "peer" }, result: true,
        }))).resolves.toBe(true);
      }, { prepareLease: prepareBindingTestLease });
      await owner.transact(key, () => ({ next: { value: "stale" }, result: true }));
    }, { prepareLease: prepareBindingTestLease })).rejects.toThrow("Lost binding lease");

    expect(values.get(key)).toEqual({ value: "peer" });
  });

  it("surfaces heartbeat lease loss without deleting the replacement owner", async () => {
    vi.useFakeTimers();
    const { state, values } = createBindingTestState();
    const owner = createNativeSessionBindingLeases(state, bindingTestOptions);
    const key = "binding-replaced-owner";
    values.set(key, { value: "owner" });
    let releaseOwner!: () => void;
    let markOwnerStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => { markOwnerStarted = resolve; });
    const holdOwner = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const ownerRun = owner.withLease(key, async () => {
      markOwnerStarted();
      await holdOwner;
    }, { prepareLease: prepareBindingTestLease });
    await ownerStarted;
    values.set(key, {
      ...values.get(key), lease: { token: "peer-owner", expiresAt: Date.now() + 120_000 },
    });

    await vi.advanceTimersByTimeAsync(30_000);
    releaseOwner();
    await expect(ownerRun).rejects.toThrow("Lost binding lease");
    expect(values.get(key)?.lease?.token).toBe("peer-owner");
  });
});
