import { describe, expect, it } from "vitest";
import { VisionBudget } from "./vision-budget.js";

describe("VisionBudget", () => {
  it("allows everything when unlimited (<= 0)", () => {
    const b = new VisionBudget(0);
    for (let i = 0; i < 100; i++) {
      expect(b.tryConsume("c", 1000 + i)).toBe(true);
    }
  });

  it("caps to maxPerMinute within the sliding window", () => {
    const b = new VisionBudget(2);
    expect(b.tryConsume("c", 1000)).toBe(true);
    expect(b.tryConsume("c", 1100)).toBe(true);
    expect(b.tryConsume("c", 1200)).toBe(false); // 3rd within the minute
  });

  it("frees up as the window slides past 60s", () => {
    const b = new VisionBudget(1);
    expect(b.tryConsume("c", 0)).toBe(true);
    expect(b.tryConsume("c", 30_000)).toBe(false); // still within 60s
    expect(b.tryConsume("c", 61_000)).toBe(true); // first hit aged out
  });

  it("tracks calls independently", () => {
    const b = new VisionBudget(1);
    expect(b.tryConsume("a", 0)).toBe(true);
    expect(b.tryConsume("b", 0)).toBe(true); // different call, own window
    expect(b.tryConsume("a", 0)).toBe(false);
  });

  it("refund returns the most recent hit (failed vision call does not count)", () => {
    const b = new VisionBudget(1);
    expect(b.tryConsume("c", 0)).toBe(true);
    b.refund("c"); // the send failed — the spend never happened
    expect(b.tryConsume("c", 0)).toBe(true);
    expect(b.tryConsume("c", 0)).toBe(false);
    b.refund("unknown"); // no-op for an untracked call
  });

  it("release clears a call's window", () => {
    const b = new VisionBudget(1);
    expect(b.tryConsume("c", 0)).toBe(true);
    expect(b.tryConsume("c", 0)).toBe(false);
    b.release("c");
    expect(b.tryConsume("c", 0)).toBe(true);
  });
});
