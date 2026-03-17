import { describe, expect, it } from "vitest";
import { createProcessedMessageTracker } from "./processed-messages.js";
describe("createProcessedMessageTracker", () => {
  it("dedupes and evicts oldest entries", () => {
    const tracker = createProcessedMessageTracker(3);
    expect(tracker.mark("a")).toBe(true);
    expect(tracker.mark("a")).toBe(false);
    expect(tracker.has("a")).toBe(true);
    tracker.mark("b");
    tracker.mark("c");
    expect(tracker.size()).toBe(3);
    tracker.mark("d");
    expect(tracker.size()).toBe(3);
    expect(tracker.has("a")).toBe(false);
    expect(tracker.has("b")).toBe(true);
    expect(tracker.has("c")).toBe(true);
    expect(tracker.has("d")).toBe(true);
  });
});
