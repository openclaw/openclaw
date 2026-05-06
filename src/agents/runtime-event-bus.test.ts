import { describe, expect, it } from "vitest";
import type { AgentRunEvent } from "./runtime-backend.js";
import { createRunEventBus } from "./runtime-event-bus.js";

function createEvent(seq: number): AgentRunEvent {
  return {
    runId: "run-event-bus",
    stream: "lifecycle",
    data: { seq },
  };
}

describe("RunEventBus", () => {
  it("serializes async event handlers in emit order", async () => {
    const order: number[] = [];
    const bus = createRunEventBus({
      onEvent: async (event) => {
        if (event.data.seq === 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        order.push(Number(event.data.seq));
      },
    });

    const first = bus.emit(createEvent(1));
    const second = bus.emit(createEvent(2));
    await Promise.all([first, second]);

    expect(order).toEqual([1, 2]);
  });

  it("drains all queued event handlers", async () => {
    const order: number[] = [];
    const bus = createRunEventBus({
      onEvent: async (event) => {
        order.push(Number(event.data.seq));
      },
    });

    void bus.emit(createEvent(1));
    void bus.emit(createEvent(2));
    await bus.drain();

    expect(order).toEqual([1, 2]);
  });

  it("surfaces event handler failures", async () => {
    const bus = createRunEventBus({
      onEvent: async () => {
        throw new Error("event sink failed");
      },
    });

    await expect(bus.emit(createEvent(1))).rejects.toThrow("event sink failed");
    await expect(bus.drain()).rejects.toThrow("event sink failed");
  });
});
