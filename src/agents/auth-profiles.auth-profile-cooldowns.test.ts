import { describe, expect, it } from "vitest";
import { calculateAuthProfileCooldownMs } from "./auth-profiles.js";

describe("auth profile cooldowns", () => {
  it("applies exponential backoff with a 5min default cap", () => {
    expect(calculateAuthProfileCooldownMs(1)).toBe(60_000);
    expect(calculateAuthProfileCooldownMs(2)).toBe(5 * 60_000);
    expect(calculateAuthProfileCooldownMs(3)).toBe(5 * 60_000);
    expect(calculateAuthProfileCooldownMs(4)).toBe(5 * 60_000);
    expect(calculateAuthProfileCooldownMs(100)).toBe(5 * 60_000);
  });

  it("falls back to default cap for invalid maxMs values", () => {
    const defaultCap = 5 * 60_000;
    expect(calculateAuthProfileCooldownMs(3, 0)).toBe(defaultCap);
    expect(calculateAuthProfileCooldownMs(3, -1)).toBe(defaultCap);
    expect(calculateAuthProfileCooldownMs(3, NaN)).toBe(defaultCap);
    expect(calculateAuthProfileCooldownMs(3, Infinity)).toBe(defaultCap);
  });

  it("respects custom maxMs parameter", () => {
    const oneHour = 60 * 60_000;
    expect(calculateAuthProfileCooldownMs(1, oneHour)).toBe(60_000);
    expect(calculateAuthProfileCooldownMs(2, oneHour)).toBe(5 * 60_000);
    expect(calculateAuthProfileCooldownMs(3, oneHour)).toBe(25 * 60_000);
    expect(calculateAuthProfileCooldownMs(4, oneHour)).toBe(oneHour);
    expect(calculateAuthProfileCooldownMs(5, oneHour)).toBe(oneHour);
  });
});
