import { describe, expect, it } from "vitest";
import { classifyRateLimitWindow, resolveRetryAfterMs } from "./retry-evidence.js";

const NOW_MS = Date.parse("2015-10-21T07:27:00.000Z");

describe("resolveRetryAfterMs", () => {
  it.each([
    ["1001 milliseconds", 1001],
    ["1001 millisecond", 1001],
    ["1001 msecs", 1001],
    ["1001 msec", 1001],
    ["1001ms", 1001],
    ["1.25 seconds", 1250],
    ["1.25 second", 1250],
    ["1.25 secs", 1250],
    ["1.25 sec", 1250],
    ["1.25s", 1250],
    ["1.5 minutes", 90_000],
    ["1.5 minute", 90_000],
    ["1.5 mins", 90_000],
    ["1.5 min", 90_000],
    ["1.5m", 90_000],
    ["0.25 hours", 900_000],
    ["0.25 hour", 900_000],
    ["0.25 hrs", 900_000],
    ["0.25 hr", 900_000],
    ["0.25h", 900_000],
    ["0.5 days", 43_200_000],
    ["0.5 day", 43_200_000],
    ["0.5d", 43_200_000],
    ["1.25", 1250],
    ["0.01ms", 1],
    ["0s", 0],
  ] as const)("converts the provider retry floor %s", (value, expected) => {
    expect(resolveRetryAfterMs(`Retry-After: ${value}`, NOW_MS)).toBe(expected);
  });

  it("keeps the largest floor across message variants and headers", () => {
    const message =
      "Retry-After: 0.5 seconds; please try again in 1.25 SECS, then continue.\nRetry after in 1s";
    expect(resolveRetryAfterMs(message, NOW_MS)).toBe(1250);
    expect(
      resolveRetryAfterMs(message, NOW_MS, {
        headers: { "retry-after": "2", "retry-after-ms": "2500.5" },
      }),
    ).toBe(2501);
    expect(
      resolveRetryAfterMs(message, NOW_MS, JSON.stringify({ headers: { "retry-after": "1" } })),
    ).toBe(1250);
  });

  it.each(["Infinity", "iNfInItY milliseconds", `${"9".repeat(400)} days`])(
    "preserves an unbounded provider retry floor: %s",
    (value) => {
      const message = `Retry-After: ${value}`;
      expect(resolveRetryAfterMs(message, NOW_MS)).toBe(Infinity);
      expect(classifyRateLimitWindow(message, NOW_MS)).toEqual({ kind: "long" });
    },
  );

  it("does not apply CLI token-length or safe-integer limits to retry floors", () => {
    expect(resolveRetryAfterMs(`Retry-After: ${"0".repeat(101)}2s`, NOW_MS)).toBe(2000);
    expect(resolveRetryAfterMs("Retry-After: 9007199254741 seconds", NOW_MS)).toBe(
      9_007_199_254_741_000,
    );
  });

  it.each([
    "Wed, 21 Oct 2015 07:28:00 GMT",
    "Wednesday, 21-Oct-15 07:28:00 GMT",
    "Wed Oct 21 07:28:00 2015",
  ])("preserves HTTP-date retry floors: %s", (date) => {
    expect(resolveRetryAfterMs(`Retry-After: ${date}`, NOW_MS)).toBe(60_000);
  });

  it("clamps elapsed HTTP dates to zero and rejects invalid dates", () => {
    expect(resolveRetryAfterMs("Retry-After: Wed, 21 Oct 2015 07:26:00 GMT", NOW_MS)).toBe(0);
    expect(
      resolveRetryAfterMs("Retry-After: Tue, 21 Oct 2015 07:28:00 GMT", NOW_MS),
    ).toBeUndefined();
  });

  it.each(["1 week", "1y", "1 month", "1 constructor", "-1s", ".5s", "1e3s", "1h30m"])(
    "rejects values outside the retry grammar: %s",
    (value) => {
      expect(resolveRetryAfterMs(`Retry-After: ${value}`, NOW_MS)).toBeUndefined();
    },
  );
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
