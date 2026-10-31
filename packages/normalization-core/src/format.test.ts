import { describe, expect, it } from "vitest";
import { bucketRelativeTimeMs, formatByteSize, formatCompactTokenCount } from "./format.js";

describe("bucketRelativeTimeMs", () => {
  it.each([
    [59_499, { value: 59, unit: "second" }],
    [59_500, { value: 1, unit: "minute" }],
    [60 * 60_000, { value: 1, unit: "hour" }],
    [48 * 3_600_000, { value: 2, unit: "day" }],
  ] as const)("buckets %sms with nested rounding", (durationMs, expected) => {
    expect(bucketRelativeTimeMs(durationMs)).toEqual(expected);
  });

  // A bucketer that never emits 1 day drops that rung entirely, so every elapsed
  // time from 24h to 48h rendered as "24h".."47h" and then jumped to "2d".
  it.each([
    [24 * 3_600_000 + 1, { value: 1, unit: "day" }],
    [30 * 3_600_000, { value: 1, unit: "day" }],
    [36 * 3_600_000, { value: 1, unit: "day" }],
    [Math.round(47.5 * 3_600_000), { value: 1, unit: "day" }],
    [Math.round(47.99 * 3_600_000), { value: 1, unit: "day" }],
  ] as const)("keeps %sms inside the one-day rung", (durationMs, expected) => {
    expect(bucketRelativeTimeMs(durationMs)).toEqual(expected);
  });

  it("reaches the one-day rung somewhere between one hour and two days", () => {
    const units = new Set<string>();
    for (let ms = 3_600_000; ms <= 48 * 3_600_000; ms += 60_000) {
      const { value, unit } = bucketRelativeTimeMs(ms);
      units.add(`${value}${unit}`);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    expect(units.has("1day")).toBe(true);
  });

  // Promotion uses each rung's own rounded value, so a duration that rounds up
  // to a whole hour must never be labelled in minutes.
  it.each([
    [3_570_000, { value: 1, unit: "hour" }],
    [3_599_000, { value: 1, unit: "hour" }],
    [3_599_999, { value: 1, unit: "hour" }],
    [3_600_000, { value: 1, unit: "hour" }],
  ] as const)("promotes %sms before labelling it as sixty minutes", (durationMs, expected) => {
    expect(bucketRelativeTimeMs(durationMs)).toEqual(expected);
  });

  it("never labels a sub-hour duration as sixty minutes", () => {
    for (let ms = 0; ms < 3_600_000; ms += 1_000) {
      const { value, unit } = bucketRelativeTimeMs(ms);
      expect(unit === "minute" ? value : 0).toBeLessThan(60);
    }
  });
});

describe("formatByteSize", () => {
  it.each([
    [
      5 * 1024 * 1024,
      { style: "legacy-binary", maxUnit: "kilo", separator: " ", fractionDigits: 1 },
      "5120.0 KB",
    ],
  ] as const)("formats %s bytes", (bytes, options, expected) => {
    expect(formatByteSize(bytes, options)).toBe(expected);
  });

  it("supports caller-owned dynamic precision and rounding", () => {
    expect(
      formatByteSize(Math.floor(99.6 * 1024 * 1024), {
        style: "legacy-binary",
        maxUnit: "giga",
        separator: " ",
        fractionDigits: (_value, unit) => (unit === "giga" ? 1 : unit === "byte" ? null : 0),
        floorUnits: ["kilo", "mega"],
      }),
    ).toBe("99 MB");
  });
});

describe("formatCompactTokenCount", () => {
  it.each([
    [999_500, { thousandsPrecision: 1 }, "999.5k"],
    [999_950, { thousandsPrecision: 1 }, "1.0m"],
  ] as const)("preserves precision-dependent rollover for %s", (tokens, options, expected) => {
    expect(formatCompactTokenCount(tokens, options)).toBe(expected);
  });

  it.each([[1_000_000_000, "1B"]] as const)(
    "selects the billion unit from the unrounded count %s",
    (tokens, expected) => {
      expect(
        formatCompactTokenCount(tokens, {
          maxUnit: "billion",
          millionsSuffix: "M",
          trimTrailingZero: true,
        }),
      ).toBe(expected);
    },
  );
});
