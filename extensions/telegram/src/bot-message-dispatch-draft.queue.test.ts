import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { enqueueDraftEvent } from "./bot-message-dispatch-draft.js";

function queueOwner() {
  let superseded = false;
  return {
    draftEventQueue: Promise.resolve(),
    isSuperseded: () => superseded,
    supersede: () => {
      superseded = true;
    },
  };
}

describe("Telegram draft event ownership", () => {
  it("suppresses superseded progress but returns admitted delivery results exactly once", async () => {
    const turn = queueOwner();
    const progress = vi.fn(async () => false);
    const deliver = vi.fn(async () => ({ visibleReplySent: true }));
    turn.supersede();
    await expect(enqueueDraftEvent(turn, progress)).resolves.toBeUndefined();
    await expect(enqueueDraftEvent(turn, deliver, "delivery")).resolves.toEqual({
      visibleReplySent: true,
    });
    expect(progress).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("propagates a delivery failure without poisoning the next operation", async () => {
    const turn = queueOwner();
    const failure = new Error("provider refused delivery");
    const failed = enqueueDraftEvent(
      turn,
      async () => {
        throw failure;
      },
      "delivery",
    );
    const next = enqueueDraftEvent(turn, async () => 42, "delivery");
    await expect(failed).rejects.toBe(failure);
    await expect(next).resolves.toBe(42);
    await turn.draftEventQueue;
  });

  it("checks revoked authority when queued delivery executes, not when admitted", async () => {
    const turn = queueOwner();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    let authorized = true;
    const refusal = new Error("authority revoked");
    const sent = vi.fn();
    const progress = enqueueDraftEvent(turn, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const delivery = enqueueDraftEvent(
      turn,
      async () => {
        if (!authorized) {
          throw refusal;
        }
        sent();
      },
      "delivery",
    );
    const rejected = expect(delivery).rejects.toBe(refusal);
    authorized = false;
    turn.supersede();
    release.resolve();
    await Promise.all([progress, rejected]);
    expect(sent).not.toHaveBeenCalled();
    await expect(enqueueDraftEvent(turn, async () => "recovered", "delivery")).resolves.toBe(
      "recovered",
    );
  });

  it("orders held progress, retirement, question and final without losing their receipts", async () => {
    const turn = queueOwner();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const operations: string[] = [];
    const progress = enqueueDraftEvent(turn, async () => {
      entered.resolve();
      await release.promise;
      operations.push("progress");
    });
    await entered.promise;
    const retirement = enqueueDraftEvent(turn, async () => {
      operations.push("retire");
    });
    const question = enqueueDraftEvent(
      turn,
      async () => {
        operations.push("question");
        return 1;
      },
      "delivery",
    );
    const final = enqueueDraftEvent(
      turn,
      async () => {
        operations.push("final");
        return 2;
      },
      "delivery",
    );
    release.resolve();
    await Promise.all([progress, retirement]);
    await expect(question).resolves.toBe(1);
    await expect(final).resolves.toBe(2);
    expect(operations).toEqual(["progress", "retire", "question", "final"]);
  });
});
