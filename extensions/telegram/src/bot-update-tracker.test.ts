import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createTelegramUpdateTracker } from "./bot-update-tracker.js";
import type { TelegramUpdateKeyContext } from "./bot-updates.js";

// Mirrors the tracker-internal retention bound; update together with bot-update-tracker.ts.
const ACCEPTED_UPDATE_ID_RETENTION = 10_000;

const updateCtx = (updateId: number): TelegramUpdateKeyContext => ({
  update: { update_id: updateId },
});

function begin(tracker: ReturnType<typeof createTelegramUpdateTracker>, id: number) {
  const result = tracker.beginUpdate(updateCtx(id));
  if (!result.accepted) {
    throw new Error(`expected update ${id} to be accepted`);
  }
  return result.update;
}

async function flushTrackerMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createTelegramUpdateTracker", () => {
  it("can persist offsets only after successful agent dispatch", async () => {
    const onAcceptedUpdateId = vi.fn();
    const tracker = createTelegramUpdateTracker({
      initialUpdateId: 100,
      onAcceptedUpdateId,
    });

    const update101 = begin(tracker, 101);
    await flushTrackerMicrotasks();
    expect(onAcceptedUpdateId).not.toHaveBeenCalled();

    const update102 = begin(tracker, 102);
    tracker.finishUpdate(update102, { completed: true });
    await flushTrackerMicrotasks();
    expect(onAcceptedUpdateId).not.toHaveBeenCalled();

    tracker.finishUpdate(update101, { completed: false });
    tracker.finishUpdate(begin(tracker, 103), { completed: true });
    await flushTrackerMicrotasks();
    expect(onAcceptedUpdateId).not.toHaveBeenCalled();

    tracker.finishUpdate(begin(tracker, 101), { completed: true });
    await flushTrackerMicrotasks();

    expect(onAcceptedUpdateId.mock.calls).toEqual([[103]]);
    expect(tracker.beginUpdate(updateCtx(101)).accepted).toBe(false);
  });

  it("skips restart replays once the accepted offset is restored", async () => {
    const onAcceptedUpdateId = vi.fn();
    const firstProcess = createTelegramUpdateTracker({
      initialUpdateId: 100,
      onAcceptedUpdateId,
    });

    firstProcess.finishUpdate(begin(firstProcess, 101), { completed: true });
    await flushTrackerMicrotasks();

    const restartedProcess = createTelegramUpdateTracker({
      initialUpdateId: Number(onAcceptedUpdateId.mock.calls.at(-1)?.[0]),
    });

    expect(restartedProcess.beginUpdate(updateCtx(101))).toEqual({
      accepted: false,
      reason: "accepted-watermark",
    });
  });

  it("can keep a persistence floor while replaying older spooled updates", async () => {
    const onAcceptedUpdateId = vi.fn();
    const tracker = createTelegramUpdateTracker({
      persistenceFloorUpdateId: 42,
      onAcceptedUpdateId,
    });

    tracker.finishUpdate(begin(tracker, 42), { completed: false });
    tracker.finishUpdate(begin(tracker, 43), { completed: true });
    await flushTrackerMicrotasks();

    expect(onAcceptedUpdateId).toHaveBeenCalledWith(43);
    expect(tracker.beginUpdate(updateCtx(42)).accepted).toBe(true);
  });

  it.each([
    { name: "below-floor replay", floor: 42, newer: [43], delayed: 42 },
    { name: "delayed cross-lane replay", floor: 100, newer: [102, 103], delayed: 101 },
  ])("dispatches $name exactly once after newer updates complete", ({ floor, newer, delayed }) => {
    const tracker = createTelegramUpdateTracker({ persistenceFloorUpdateId: floor });
    const updates = newer.map((id) => begin(tracker, id));
    for (const update of updates) {
      tracker.finishUpdate(update, { completed: true });
    }
    tracker.finishUpdate(begin(tracker, delayed), { completed: true });
    const replay = tracker.beginUpdate(updateCtx(delayed));
    expect(replay.accepted).toBe(false);
    if (delayed > floor) {
      expect(replay).toEqual({ accepted: false, reason: "accepted-watermark" });
    }
    expect(tracker.beginUpdate(updateCtx(newer.at(-1)!)).accepted).toBe(false);
  });

  it("does not prune pending or failed accepted ids from the retention window", () => {
    const tracker = createTelegramUpdateTracker({ persistenceFloorUpdateId: 0 });
    const pendingId = 1;
    const failedId = 2;
    begin(tracker, pendingId);
    tracker.finishUpdate(begin(tracker, failedId), { completed: false });

    const lastId = ACCEPTED_UPDATE_ID_RETENTION + 50;
    for (let updateId = 3; updateId <= lastId; updateId += 1) {
      tracker.finishUpdate(begin(tracker, updateId), { completed: true });
    }

    // Pending ids stay in the numeric set, but rejection is not a terminal fact.
    expect(tracker.beginUpdate(updateCtx(pendingId))).toEqual({
      accepted: false,
      reason: "pending",
    });
    expect(tracker.beginUpdate(updateCtx(3)).accepted).toBe(true);
    expect(tracker.beginUpdate(updateCtx(lastId)).accepted).toBe(false);
    tracker.finishUpdate(begin(tracker, failedId), { completed: true });
    // After success, re-begin is rejected (numeric and/or semantic).
    expect(tracker.beginUpdate(updateCtx(failedId)).accepted).toBe(false);
  });

  it("serializes and coalesces accepted offset persistence", async () => {
    const firstWrite = createDeferred<void>();
    const secondWrite = createDeferred<void>();
    const writes: number[] = [];
    const onAcceptedUpdateId = vi.fn((updateId: number) => {
      writes.push(updateId);
      if (updateId === 101) {
        return firstWrite.promise;
      }
      return secondWrite.promise;
    });
    const tracker = createTelegramUpdateTracker({
      initialUpdateId: 100,
      onAcceptedUpdateId,
    });

    tracker.finishUpdate(begin(tracker, 101), { completed: true });
    tracker.finishUpdate(begin(tracker, 102), { completed: true });
    tracker.finishUpdate(begin(tracker, 103), { completed: true });

    await flushTrackerMicrotasks();
    expect(writes).toEqual([101]);

    firstWrite.resolve();
    await flushTrackerMicrotasks();
    expect(writes).toEqual([101, 103]);
    expect(onAcceptedUpdateId).not.toHaveBeenCalledWith(102);

    secondWrite.resolve();
    await flushTrackerMicrotasks();
    tracker.finishUpdate(begin(tracker, 104), { completed: true });
    await flushTrackerMicrotasks();
    expect(writes).toEqual([101, 103, 104]);
  });

  it("does not record an update when checking handler dispatch before acceptance", () => {
    const onSkip = vi.fn();
    const tracker = createTelegramUpdateTracker({ initialUpdateId: 300, onSkip });
    const ctx = updateCtx(301);

    expect(tracker.shouldSkipHandlerDispatch(ctx)).toBe(false);
    expect(tracker.shouldSkipHandlerDispatch(ctx)).toBe(false);
    expect(onSkip).not.toHaveBeenCalled();

    const accepted = begin(tracker, 301);

    expect(tracker.shouldSkipHandlerDispatch(ctx)).toBe(false);
    tracker.finishUpdate(accepted, { completed: true });
    expect(tracker.shouldSkipHandlerDispatch(ctx)).toBe(true);
  });

  it("dedupes handler dispatch separately from the accepted watermark", () => {
    const onSkip = vi.fn();
    const tracker = createTelegramUpdateTracker({ initialUpdateId: 300, onSkip });
    const accepted = begin(tracker, 301);

    expect(tracker.shouldSkipHandlerDispatch(updateCtx(301))).toBe(false);
    expect(tracker.shouldSkipHandlerDispatch(updateCtx(301))).toBe(true);
    expect(onSkip).toHaveBeenCalledWith("update:301");

    tracker.finishUpdate(accepted, { completed: true });
    expect(tracker.shouldSkipHandlerDispatch(updateCtx(301))).toBe(true);
  });
});
