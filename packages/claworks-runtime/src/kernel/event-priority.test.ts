import { describe, expect, it } from "vitest";
import { compareEventPriority, resolveEventPriority } from "./event-priority.js";

describe("event-priority", () => {
  it("orders CRITICAL before HIGH", () => {
    expect(compareEventPriority("CRITICAL", "HIGH")).toBeLessThan(0);
  });

  it("infers alarm as CRITICAL", () => {
    expect(resolveEventPriority("equipment.alarm", {})).toBe("CRITICAL");
  });

  it("respects explicit payload priority", () => {
    expect(resolveEventPriority("x", { priority: "LOW" })).toBe("LOW");
  });
});
