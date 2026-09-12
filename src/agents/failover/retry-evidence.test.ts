import { describe, expect, it } from "vitest";
import { isLongWindowRetryAfterMs } from "./retry-evidence.js";

describe("isLongWindowRetryAfterMs", () => {
  it("shares the 60s short-window ceiling with retry text", () => {
    expect(isLongWindowRetryAfterMs(undefined)).toBe(false);
    expect(isLongWindowRetryAfterMs(60_000)).toBe(false);
    expect(isLongWindowRetryAfterMs(60_001)).toBe(true);
    expect(isLongWindowRetryAfterMs(Infinity)).toBe(true);
  });
});
