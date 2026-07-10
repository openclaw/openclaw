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
    tracker.beginSnapshot(snapshot);
    for (const key of snapshot) {
      await expect(tracker.process(key, async () => true)).resolves.toBe(true);
    }

    tracker.beginSnapshot(snapshot);
    const duplicateResults = await Promise.all(
      snapshot.map((key) => tracker.process(key, async () => true)),
    );
    expect(duplicateResults.some(Boolean)).toBe(false);

    tracker.beginSnapshot(snapshot.slice(1));
    tracker.beginSnapshot(snapshot);
    await expect(tracker.process(snapshot[0], async () => true)).resolves.toBe(true);
    await expect(tracker.process(snapshot.at(-1)!, async () => true)).resolves.toBe(false);
  });

  it("lets an overlapping snapshot retry failed in-flight work", async () => {
    const tracker = createActiveSnapshotTracker();
    tracker.beginSnapshot(["invite"]);
    let finishFirst!: (completed: boolean) => void;
    const firstResult = new Promise<boolean>((resolve) => {
      finishFirst = resolve;
    });
    const first = tracker.process("invite", () => firstResult);
    const retryTask = vi.fn(async () => true);
    const second = tracker.process("invite", retryTask);

    await Promise.resolve();
    expect(retryTask).not.toHaveBeenCalled();
    finishFirst(false);

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(retryTask).toHaveBeenCalledTimes(1);
  });

  it("lets a waiter retry rejected in-flight work", async () => {
    const tracker = createActiveSnapshotTracker();
    tracker.beginSnapshot(["invite"]);
    let rejectFirst!: (error: Error) => void;
    const firstResult = new Promise<boolean>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const first = tracker.process("invite", () => firstResult);
    const retryTask = vi.fn(async () => true);
    const second = tracker.process("invite", retryTask);

    await Promise.resolve();
    expect(retryTask).not.toHaveBeenCalled();
    rejectFirst(new Error("failed"));

    await expect(first).rejects.toThrow("failed");
    await expect(second).resolves.toBe(true);
    expect(retryTask).toHaveBeenCalledTimes(1);
  });
});
