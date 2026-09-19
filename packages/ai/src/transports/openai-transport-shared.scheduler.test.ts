import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelStreamCooperativeScheduler } from "./openai-transport-shared.js";

describe("model stream cooperative scheduler", { concurrent: false }, () => {
  let now = 0;

  beforeEach(() => {
    now = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(async () => {
    try {
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("starts a fresh event and elapsed-time budget after a delayed yield", async () => {
    const scheduler = createModelStreamCooperativeScheduler();

    async function expectImmediateEvent() {
      const event = scheduler.afterEvent();
      // Check before awaiting so an unexpected yield fails without a timer timeout.
      expect(vi.getTimerCount()).toBe(0);
      await event;
    }

    async function finishYieldAt(deliveredAt: number) {
      let settled = false;
      const event = scheduler.afterEvent().then(() => {
        settled = true;
      });
      expect(vi.getTimerCount()).toBe(1);
      await Promise.resolve();
      expect(settled).toBe(false);
      now = deliveredAt;
      await vi.runOnlyPendingTimersAsync();
      await event;
      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }

    for (let index = 0; index < 63; index += 1) {
      await expectImmediateEvent();
    }
    await finishYieldAt(25);

    for (let index = 0; index < 63; index += 1) {
      await expectImmediateEvent();
    }
    await finishYieldAt(50);

    now = 61;
    await expectImmediateEvent();
    now = 62;
    await finishYieldAt(87);
    await expectImmediateEvent();
  });

  it.each(["before event", "during yield"] as const)(
    "preserves a coded abort reason %s",
    async (phase) => {
      const controller = new AbortController();
      const reason = Object.assign(new Error("Stream canceled"), { code: "TEST_CANCELED" });
      const scheduler = createModelStreamCooperativeScheduler(controller.signal);
      if (phase === "before event") {
        controller.abort(reason);
        await expect(scheduler.afterEvent()).rejects.toBe(reason);
        expect(vi.getTimerCount()).toBe(0);
        return;
      }

      now = 12;
      const event = scheduler.afterEvent();
      const rejected = expect(event).rejects.toBe(reason);
      expect(vi.getTimerCount()).toBe(1);
      controller.abort(reason);
      now = 37;
      await vi.runOnlyPendingTimersAsync();
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
