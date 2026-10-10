import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createTelegramUpdateTracker } from "./bot-update-tracker.js";
import type { TelegramUpdateKeyContext } from "./bot-updates.js";

// Mirrors the tracker-internal retention bound; update together with bot-update-tracker.ts.
const ACCEPTED_UPDATE_ID_RETENTION = 10_000;

const updateCtx = (updateId: number): TelegramUpdateKeyContext => ({
  update: { update_id: updateId },
});

async function flushTrackerMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createTelegramUpdateTracker", () => {
  it("can persist offsets only after successful agent dispatch", async () => {
    const onAcceptedUpdateId = vi.fn();
    const tracker = createTelegramUpdateTracker({
      initialUpdateId: 100,
      ackPolicy: "after_agent_dispatch",
      onAcceptedUpdateId,
    });

    const update101 = tracker.beginUpdate(updateCtx(101));
    if (!update101.accepted) {
      throw new Error("expected update 101 to be accepted");
    }
    await flushTrackerMicrotasks();
    expect(onAcceptedUpdateId).not.toHaveBeenCalled();

    const update102 = tracker.beginUpdate(updateCtx(102));
    if (!update102.accepted) {
      throw new Error("expected update 102 to be accepted");
    }
    tracker.finishUpdate(update102.update, { completed: true });
    await flushTrackerMicrotasks();
    expect(onAcceptedUpdateId).not.toHaveBeenCalled();

    tracker.finishUpdate(update101.update, { completed: false });
    const update103 = tracker.beginUpdate(updateCtx(103));
    if (!update103.accepted) {
      throw new Error("expected update 103 to be accepted");
    }
    tracker.finishUpdate(update103.update, { completed: true });
    await flushTrackerMicrotasks();
    expect(onAcceptedUpdateId).not.toHaveBeenCalled();

    const retry = tracker.beginUpdate(updateCtx(101));
    if (!retry.accepted) {
      throw new Error("expected update 101 retry to be accepted");
    }
    tracker.finishUpdate(retry.update, { completed: true });
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

    const accepted = firstProcess.beginUpdate(updateCtx(101));
    expect(accepted.accepted).toBe(true);
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
      initialUpdateId: null,
      persistenceFloorUpdateId: 42,
      ackPolicy: "after_agent_dispatch",
      onAcceptedUpdateId,
    });

    const oldPending = tracker.beginUpdate(updateCtx(42));
    if (!oldPending.accepted) {
      throw new Error("expected old spooled update to be accepted");
    }
    tracker.finishUpdate(oldPending.update, { completed: false });

    const newer = tracker.beginUpdate(updateCtx(43));
    if (!newer.accepted) {
      throw new Error("expected newer update to be accepted");
    }
    tracker.finishUpdate(newer.update, { completed: true });
    await flushTrackerMicrotasks();

    expect(onAcceptedUpdateId).toHaveBeenCalledWith(43);
    expect(tracker.beginUpdate(updateCtx(42)).accepted).toBe(true);
  });

  it("keeps below-floor spool replays dispatchable after newer updates advance", () => {
    const tracker = createTelegramUpdateTracker({
      initialUpdateId: null,
      persistenceFloorUpdateId: 42,
      ackPolicy: "after_agent_dispatch",
    });

    const newer = tracker.beginUpdate(updateCtx(43));
    if (!newer.accepted) {
      throw new Error("expected newer update to be accepted");
    }
    tracker.finishUpdate(newer.update, { completed: true });

    const oldReplay = tracker.beginUpdate(updateCtx(42));
    if (!oldReplay.accepted) {
      throw new Error("expected below-floor replay to remain accepted");
    }
    tracker.finishUpdate(oldReplay.update, { completed: true });

    // Second begin is rejected (numeric set and/or semantic key). After persist
    // advances, the numeric id may already be pruned below the persisted floor.
    expect(tracker.beginUpdate(updateCtx(42)).accepted).toBe(false);
    expect(tracker.beginUpdate(updateCtx(43)).accepted).toBe(false);
  });

  it("dispatches a delayed lower update id after newer cross-lane ids complete", () => {
    const tracker = createTelegramUpdateTracker({
      initialUpdateId: null,
      persistenceFloorUpdateId: 100,
      ackPolicy: "after_agent_dispatch",
    });

    // Lane B finishes newer global update ids while lane A still holds N+1.
    const laterA = tracker.beginUpdate(updateCtx(102));
    const laterB = tracker.beginUpdate(updateCtx(103));
    if (!laterA.accepted || !laterB.accepted) {
      throw new Error("expected later cross-lane updates to be accepted");
    }
    tracker.finishUpdate(laterA.update, { completed: true });
    tracker.finishUpdate(laterB.update, { completed: true });

    // Delayed durable-spool replay of N+1 must still dispatch exactly once.
    const delayed = tracker.beginUpdate(updateCtx(101));
    if (!delayed.accepted) {
      throw new Error("expected delayed cross-lane spool replay to be accepted");
    }
    tracker.finishUpdate(delayed.update, { completed: true });

    expect(tracker.beginUpdate(updateCtx(101))).toEqual({
      accepted: false,
      reason: "accepted-watermark",
    });
    expect(tracker.beginUpdate(updateCtx(103)).accepted).toBe(false);
  });

  it("does not prune pending or failed accepted ids from the retention window", () => {
    const tracker = createTelegramUpdateTracker({
      initialUpdateId: null,
      persistenceFloorUpdateId: 0,
      ackPolicy: "after_agent_dispatch",
    });
    const pendingId = 1;
    const failedId = 2;
    const pending = tracker.beginUpdate(updateCtx(pendingId));
    const failed = tracker.beginUpdate(updateCtx(failedId));
    if (!pending.accepted || !failed.accepted) {
      throw new Error("expected seed updates to be accepted");
    }
    tracker.finishUpdate(failed.update, { completed: false });

    const lastId = ACCEPTED_UPDATE_ID_RETENTION + 50;
    for (let updateId = 3; updateId <= lastId; updateId += 1) {
      const begun = tracker.beginUpdate(updateCtx(updateId));
      if (!begun.accepted) {
        throw new Error(`expected update ${updateId} to be accepted`);
      }
      tracker.finishUpdate(begun.update, { completed: true });
    }

    // Pending ids stay in the numeric set (never pruned) so re-begin is rejected
    // as accepted-watermark, not re-dispatched.
    expect(tracker.beginUpdate(updateCtx(pendingId))).toEqual({
      accepted: false,
      reason: "accepted-watermark",
    });
    expect(tracker.beginUpdate(updateCtx(3)).accepted).toBe(true);
    expect(tracker.beginUpdate(updateCtx(lastId)).accepted).toBe(false);
    const failedRetry = tracker.beginUpdate(updateCtx(failedId));
    if (!failedRetry.accepted) {
      throw new Error("expected failed update retry to be accepted");
    }
    tracker.finishUpdate(failedRetry.update, { completed: true });
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

    const update101 = tracker.beginUpdate(updateCtx(101));
    const update102 = tracker.beginUpdate(updateCtx(102));
    const update103 = tracker.beginUpdate(updateCtx(103));
    expect(update101.accepted).toBe(true);
    expect(update102.accepted).toBe(true);
    expect(update103.accepted).toBe(true);

    await flushTrackerMicrotasks();
    expect(writes).toEqual([101]);

    firstWrite.resolve();
    await flushTrackerMicrotasks();
    expect(writes).toEqual([101, 103]);
    expect(onAcceptedUpdateId).not.toHaveBeenCalledWith(102);

    secondWrite.resolve();
    await flushTrackerMicrotasks();
    expect(tracker.beginUpdate(updateCtx(104)).accepted).toBe(true);
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

    const accepted = tracker.beginUpdate(ctx);
    if (!accepted.accepted) {
      throw new Error("expected read-only skip checks to leave the update retryable");
    }

    expect(tracker.shouldSkipHandlerDispatch(ctx)).toBe(false);
    tracker.finishUpdate(accepted.update, { completed: true });
    expect(tracker.shouldSkipHandlerDispatch(ctx)).toBe(true);
  });

  it("dedupes handler dispatch separately from the accepted watermark", () => {
    const onSkip = vi.fn();
    const tracker = createTelegramUpdateTracker({ initialUpdateId: 300, onSkip });
    const accepted = tracker.beginUpdate(updateCtx(301));
    if (!accepted.accepted) {
      throw new Error("expected update to be accepted");
    }

    expect(tracker.shouldSkipHandlerDispatch(updateCtx(301))).toBe(false);
    expect(tracker.shouldSkipHandlerDispatch(updateCtx(301))).toBe(true);
    expect(onSkip).toHaveBeenCalledWith("update:301");

    tracker.finishUpdate(accepted.update, { completed: true });
    expect(tracker.shouldSkipHandlerDispatch(updateCtx(301))).toBe(true);
  });
});
