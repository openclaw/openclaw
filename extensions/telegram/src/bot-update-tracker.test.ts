import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createTelegramUpdateTracker } from "./bot-update-tracker.js";
import type { TelegramUpdateKeyContext } from "./bot-updates.js";

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
    const tracker = createTelegramUpdateTracker({ initialUpdateId: 100, onAcceptedUpdateId });

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
    const firstProcess = createTelegramUpdateTracker({ initialUpdateId: 100, onAcceptedUpdateId });

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
    tracker.finishUpdate(begin(tracker, 42), { completed: true });
    expect(tracker.beginUpdate(updateCtx(42)).accepted).toBe(false);
    expect(tracker.beginUpdate(updateCtx(43)).accepted).toBe(false);
  });

  it("dispatches delayed cross-lane replay exactly once after newer updates complete", () => {
    const tracker = createTelegramUpdateTracker({ persistenceFloorUpdateId: 100 });
    const updates = [102, 103].map((id) => begin(tracker, id));
    for (const update of updates) {
      tracker.finishUpdate(update, { completed: true });
    }
    tracker.finishUpdate(begin(tracker, 101), { completed: true });
    expect(tracker.beginUpdate(updateCtx(101))).toEqual({
      accepted: false,
      reason: "accepted-watermark",
    });
    expect(tracker.beginUpdate(updateCtx(103)).accepted).toBe(false);
  });

  it("does not prune pending or failed accepted ids from the retention window", () => {
    const tracker = createTelegramUpdateTracker({ persistenceFloorUpdateId: 0 });
    begin(tracker, 1);
    tracker.finishUpdate(begin(tracker, 2), { completed: false });

    const lastId = 10_050; // Beyond the tracker's 10,000-id retention window.
    for (let updateId = 3; updateId <= lastId; updateId += 1) {
      tracker.finishUpdate(begin(tracker, updateId), { completed: true });
    }

    expect(tracker.beginUpdate(updateCtx(1))).toEqual({
      accepted: false,
      reason: "pending",
    });
    expect(tracker.beginUpdate(updateCtx(3)).accepted).toBe(true);
    expect(tracker.beginUpdate(updateCtx(lastId)).accepted).toBe(false);
    tracker.finishUpdate(begin(tracker, 2), { completed: true });
    expect(tracker.beginUpdate(updateCtx(2)).accepted).toBe(false);
  });

  it("serializes and coalesces accepted offset persistence", async () => {
    const firstWrite = createDeferred<void>();
    const secondWrite = createDeferred<void>();
    const onAcceptedUpdateId = vi.fn((updateId: number) => {
      return updateId === 101 ? firstWrite.promise : secondWrite.promise;
    });
    const tracker = createTelegramUpdateTracker({ initialUpdateId: 100, onAcceptedUpdateId });

    tracker.finishUpdate(begin(tracker, 101), { completed: true });
    tracker.finishUpdate(begin(tracker, 102), { completed: true });
    tracker.finishUpdate(begin(tracker, 103), { completed: true });

    await flushTrackerMicrotasks();
    expect(onAcceptedUpdateId.mock.calls).toEqual([[101]]);

    firstWrite.resolve();
    await flushTrackerMicrotasks();
    expect(onAcceptedUpdateId.mock.calls).toEqual([[101], [103]]);

    secondWrite.resolve();
    await flushTrackerMicrotasks();
    tracker.finishUpdate(begin(tracker, 104), { completed: true });
    await flushTrackerMicrotasks();
    expect(onAcceptedUpdateId.mock.calls).toEqual([[101], [103], [104]]);
  });

  it("dedupes handler dispatch only after acceptance, independently of completion", () => {
    const onSkip = vi.fn();
    const tracker = createTelegramUpdateTracker({ initialUpdateId: 300, onSkip });
    const ctx = updateCtx(301);

    expect(tracker.shouldSkipHandlerDispatch(ctx)).toBe(false);
    expect(tracker.shouldSkipHandlerDispatch(ctx)).toBe(false);
    expect(onSkip).not.toHaveBeenCalled();

    const accepted = begin(tracker, 301);

    expect(tracker.shouldSkipHandlerDispatch(ctx)).toBe(false);
    expect(tracker.shouldSkipHandlerDispatch(ctx)).toBe(true);
    expect(onSkip).toHaveBeenCalledWith("update:301");
    tracker.finishUpdate(accepted, { completed: true });
    expect(tracker.shouldSkipHandlerDispatch(ctx)).toBe(true);
  });
});
