// Browser tests cover timer delay plugin behavior.
import { describe, expect, it } from "vitest";
import { normalizeBrowserTimerDelayMs } from "./timer-delay.js";

describe("normalizeBrowserTimerDelayMs", () => {
  it("preserves positive integer timers and applies the minimum", () => {
    expect(normalizeBrowserTimerDelayMs(1234.9)).toBe(1234);
    expect(normalizeBrowserTimerDelayMs(-5)).toBe(1);
    expect(normalizeBrowserTimerDelayMs(0, { minMs: 0 })).toBe(0);
  });
});
