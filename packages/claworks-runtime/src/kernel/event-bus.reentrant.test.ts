import { describe, expect, it } from "vitest";
import { createEventBus } from "./event-bus.js";
import { createPlaybookMatcher } from "./playbook-matcher.js";

describe("event-bus reentrant publish", () => {
  it("resolves nested publish during subscriber handler", async () => {
    const bus = createEventBus({ matcher: createPlaybookMatcher() });

    bus.subscribe("alarm.created", () =>
      bus.publish({
        id: "nested-1",
        type: "workorder.created",
        source: "test",
        payload: {},
        timestamp: Date.now(),
      }),
    );

    await bus.publish({
      id: "outer-1",
      type: "alarm.created",
      source: "test",
      payload: {},
      timestamp: Date.now(),
    });

    const queried = await bus.query({ limit: 10 });
    expect(queried.some((e) => e.id === "nested-1")).toBe(true);
  });
});
