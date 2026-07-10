// Tlon monitor tracking tests cover thread eviction and snapshot lifecycle.
import { describe, expect, it, vi } from "vitest";
import { createActiveSnapshotTracker, createParticipatedThreadTracker } from "./tracking.js";

describe("createParticipatedThreadTracker", () => {
  it("evicts the least recently used thread at the configured limit", () => {
    const tracker = createParticipatedThreadTracker(3);
    tracker.add("oldest");
    tracker.add("refreshed");
    tracker.add("recent");

    expect(tracker.has("refreshed")).toBe(true);
    tracker.add("newest");

    expect(tracker.size()).toBe(3);
    expect(tracker.has("oldest")).toBe(false);
    expect(tracker.has("refreshed")).toBe(true);
    expect(tracker.has("recent")).toBe(true);
    expect(tracker.has("newest")).toBe(true);
  });
});

describe("createActiveSnapshotTracker", () => {
  it("suppresses the full active snapshot without retaining removed keys", async () => {
    const tracker = createActiveSnapshotTracker();
    const snapshot = Array.from({ length: 2001 }, (_, index) => `invite-${index}`);
    const initialSnapshot = tracker.beginSnapshot(snapshot);
    for (const key of snapshot) {
      await expect(initialSnapshot.process(key, async () => true)).resolves.toBe(true);
    }

    const repeatedSnapshot = tracker.beginSnapshot(snapshot);
    const duplicateResults = await Promise.all(
      snapshot.map((key) => repeatedSnapshot.process(key, async () => true)),
    );
    expect(duplicateResults.some(Boolean)).toBe(false);

    tracker.beginSnapshot(snapshot.slice(1));
    const reappearedSnapshot = tracker.beginSnapshot(snapshot);
    await expect(reappearedSnapshot.process(snapshot[0], async () => true)).resolves.toBe(true);
    await expect(reappearedSnapshot.process(snapshot.at(-1)!, async () => true)).resolves.toBe(
      false,
    );
  });

  it("separates work when an invite is removed and re-added in flight", async () => {
    const tracker = createActiveSnapshotTracker();
    const oldSnapshot = tracker.beginSnapshot(["invite"]);
    let finishOld!: (completed: boolean) => void;
    const oldResult = new Promise<boolean>((resolve) => {
      finishOld = resolve;
    });
    const oldTask = vi.fn(() => oldResult);
    const old = oldSnapshot.process("invite", oldTask);

    await Promise.resolve();
    expect(oldTask).toHaveBeenCalledTimes(1);
    tracker.beginSnapshot([]);
    const currentSnapshot = tracker.beginSnapshot(["invite"]);

    let finishCurrent!: (completed: boolean) => void;
    const currentResult = new Promise<boolean>((resolve) => {
      finishCurrent = resolve;
    });
    const currentTask = vi.fn(() => currentResult);
    const current = currentSnapshot.process("invite", currentTask);
    const retryTask = vi.fn(async () => true);
    const waiter = currentSnapshot.process("invite", retryTask);

    await Promise.resolve();
    expect(currentTask).toHaveBeenCalledTimes(1);
    expect(retryTask).not.toHaveBeenCalled();
    finishOld(true);
    await expect(old).resolves.toBe(true);
    expect(retryTask).not.toHaveBeenCalled();

    const lateRetryTask = vi.fn(async () => true);
    const lateWaiter = currentSnapshot.process("invite", lateRetryTask);
    await Promise.resolve();
    expect(retryTask).not.toHaveBeenCalled();
    expect(lateRetryTask).not.toHaveBeenCalled();

    finishCurrent(false);
    await expect(current).resolves.toBe(false);
    const waiterResults = await Promise.all([waiter, lateWaiter]);
    expect(waiterResults).toContain(true);
    expect(retryTask.mock.calls.length + lateRetryTask.mock.calls.length).toBe(1);
  });

  it("does not let delayed work from a stale snapshot adopt the current generation", async () => {
    const tracker = createActiveSnapshotTracker();
    const oldSnapshot = tracker.beginSnapshot(["blocking", "invite"]);
    let releaseBlocking!: () => void;
    const blockingResult = new Promise<boolean>((resolve) => {
      releaseBlocking = () => resolve(true);
    });
    const blocking = oldSnapshot.process("blocking", () => blockingResult);
    await Promise.resolve();

    tracker.beginSnapshot([]);
    const currentSnapshot = tracker.beginSnapshot(["invite"]);
    let releaseCurrent!: () => void;
    const currentResult = new Promise<boolean>((resolve) => {
      releaseCurrent = () => resolve(true);
    });
    const currentTask = vi.fn(() => currentResult);
    const current = currentSnapshot.process("invite", currentTask);
    await Promise.resolve();
    expect(currentTask).toHaveBeenCalledTimes(1);

    releaseBlocking();
    await expect(blocking).resolves.toBe(true);
    const staleTask = vi.fn(async () => true);
    await expect(oldSnapshot.process("invite", staleTask)).resolves.toBe(false);
    expect(staleTask).not.toHaveBeenCalled();

    releaseCurrent();
    await expect(current).resolves.toBe(true);
  });

  it("lets a waiter retry rejected in-flight work", async () => {
    const tracker = createActiveSnapshotTracker();
    const snapshot = tracker.beginSnapshot(["invite"]);
    let rejectFirst!: (error: Error) => void;
    const firstResult = new Promise<boolean>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const first = snapshot.process("invite", () => firstResult);
    const retryTask = vi.fn(async () => true);
    const second = snapshot.process("invite", retryTask);

    await Promise.resolve();
    expect(retryTask).not.toHaveBeenCalled();
    rejectFirst(new Error("failed"));

    await expect(first).rejects.toThrow("failed");
    await expect(second).resolves.toBe(true);
    expect(retryTask).toHaveBeenCalledTimes(1);
  });
});
