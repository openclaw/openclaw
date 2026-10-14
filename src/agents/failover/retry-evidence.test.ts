import { describe, expect, it } from "vitest";
import { classifyRateLimitWindow, resolveRetryAfterMs } from "./retry-evidence.js";

const NOW_MS = Date.parse("2015-10-21T07:27:00.000Z");
const MULTIPLE_FLOORS =
  "Retry-After: 0.5 seconds; please try again in 1.25 SECS, then continue.\nRetry after in 1s";

describe("resolveRetryAfterMs", () => {
  it.each<[string, number | undefined, unknown?]>([
    ["Retry-After: 1001ms", 1001],
    ["Retry-After: 1.25 seconds", 1250],
    ["Retry-After: 1.5 minutes", 90_000],
    ["Retry-After: 0.25 hours", 900_000],
    ["Retry-After: 0.5 days", 43_200_000],
    ["Retry-After: 1.25", 1250],
    ["Retry-After: 0.01ms", 1],
    ["Retry-After: 0s", 0],
    ["Retry-After: iNfInItY milliseconds", Infinity],
    [`Retry-After: ${"9".repeat(400)} days`, Infinity],
    [`Retry-After: ${"0".repeat(101)}2s`, 2000],
    ["Retry-After: 9007199254741 seconds", 9_007_199_254_741_000],
    ["Retry-After: Wed, 21 Oct 2015 07:28:00 GMT", 60_000],
    ["Retry-After: Wed, 21 Oct 2015 07:26:00 GMT", 0],
    ["Retry-After: Tue, 21 Oct 2015 07:28:00 GMT", undefined],
    ["Retry-After: 1 constructor", undefined],
    ["Retry-After: -1s", undefined],
    [MULTIPLE_FLOORS, 1250],
    [MULTIPLE_FLOORS, 2501, { headers: { "retry-after": "2", "retry-after-ms": "2500.5" } }],
    [MULTIPLE_FLOORS, 1250, JSON.stringify({ headers: { "retry-after": "1" } })],
  ])("resolves the provider floor from %s", (message, expected, errorBody) => {
    expect(resolveRetryAfterMs(message, NOW_MS, errorBody)).toBe(expected);
    if (expected === Infinity) {
      expect(classifyRateLimitWindow(message, NOW_MS)).toEqual({ kind: "long" });
    }
  });
});

describe("classifyRateLimitWindow", () => {
  it("compares converted fractions against the one-minute short-window limit", () => {
    expect(classifyRateLimitWindow("429 Try again in 0.5 minutes", NOW_MS)).toEqual({
      kind: "short",
      retryAfterSeconds: 30,
    });
    expect(classifyRateLimitWindow("429 Retry-After: 60000ms", NOW_MS)).toEqual({
      kind: "short",
      retryAfterSeconds: 60,
    });
    expect(classifyRateLimitWindow("429 Retry-After: 60001ms", NOW_MS)).toEqual({ kind: "long" });
  });
});
