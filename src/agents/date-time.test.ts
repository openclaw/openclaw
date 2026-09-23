// Covers prompt date/time formatting, timezone changes, and timestamp fallbacks.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCronStyleNow } from "./current-time.js";
import {
  formatDateStamp,
  formatUserTime,
  resolveUserTimeFormat,
  resolveUserTimezone,
} from "./date-time.js";

vi.mock("node:child_process", () => ({
  execFileSync: () => {
    throw new Error("No explicit operating-system clock preference");
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveUserTimeFormat", () => {
  it("uses a 24-hour locale even when its hour digits are not Latin", () => {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    const native = new RealDateTimeFormat("fa-IR", { hour: "numeric" });
    expect(native.resolvedOptions().hour12).toBe(false);
    expect(native.format(new Date(2000, 0, 1, 13))).not.toContain("13");
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      return new RealDateTimeFormat(locales ?? "fa-IR", options);
    });

    expect(resolveUserTimeFormat()).toBe("24");
    const current = resolveCronStyleNow(
      { agents: { defaults: { userTimezone: "UTC" } } },
      Date.parse("2026-09-13T13:05:00.000Z"),
    );
    expect(current.formattedTime).toBe("Sunday, September 13th, 2026 - 13:05");
    expect(current.timeLine).toContain("Reference UTC: 2026-09-13 13:05 UTC");
    expect(resolveUserTimeFormat("12")).toBe("12");
    expect(resolveUserTimeFormat("24")).toBe("24");
  });
});

describe("resolveUserTimezone", () => {
  it("keeps configured zones fixed while host fallback follows timezone changes", () => {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    let hostTimezone = "UTC";
    // Thread workers cannot change Intl's host timezone through process.env.TZ.
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      return new RealDateTimeFormat(locales, {
        ...options,
        timeZone: options?.timeZone ?? hostTimezone,
      });
    });
    for (const timezone of ["UTC", "America/New_York", "UTC"]) {
      hostTimezone = timezone;
      expect(resolveUserTimezone(" Asia/Tokyo ")).toBe("Asia/Tokyo");
      for (const configured of [undefined, "", "Invalid/Timezone"]) {
        expect(resolveUserTimezone(configured)).toBe(timezone);
      }
    }
  });
});

describe("formatDateStamp", () => {
  it("follows local midnight, DST, and timezone changes across calls", () => {
    for (const [timestamp, timezone, expected] of [
      ["2026-03-28T22:30:00.000Z", "Europe/Vienna", "2026-03-28"],
      ["2026-03-28T23:30:00.000Z", "Europe/Vienna", "2026-03-29"],
      ["2026-03-29T22:30:00.000Z", "Europe/Vienna", "2026-03-30"],
      ["2026-03-29T22:30:00.000Z", "UTC", "2026-03-29"],
      ["2026-03-29T22:30:00.000Z", "Europe/Vienna", "2026-03-30"],
    ] as const) {
      expect(formatDateStamp(Date.parse(timestamp), timezone)).toBe(expected);
    }
    const timestamp = Date.parse("2026-03-29T22:30:00.000Z");
    expect(() => formatDateStamp(timestamp, "Invalid/Timezone")).toThrow(RangeError);
    expect(formatDateStamp(timestamp, "Europe/Vienna")).toBe("2026-03-30");
  });

  it("falls back when nowMs is outside Date range", () => {
    // Runtime callers can pass invalid epoch values; Date.now is the safe
    // fallback when still within Date's supported range.
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));

    expect(formatDateStamp(8_640_000_000_000_001, "UTC")).toBe("2026-05-30");
  });

  it("falls back to epoch when both nowMs and Date.now are outside Date range", () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);

    expect(formatDateStamp(8_640_000_000_000_001, "UTC")).toBe("1970-01-01");
  });
});

describe("formatUserTime", () => {
  it("follows timestamp, timezone, and hour-format changes across calls", () => {
    const before = new Date("2026-03-29T00:30:00.000Z");
    const after = new Date("2026-03-29T01:30:00.000Z");
    for (const [date, timezone, format, expectedTime] of [
      [before, "Europe/Vienna", "12", "1:30 AM"],
      [before, "Europe/Vienna", "24", "01:30"],
      [after, "Europe/Vienna", "24", "03:30"],
      [after, "UTC", "24", "01:30"],
      [after, "Europe/Vienna", "12", "3:30 AM"],
    ] as const) {
      expect(formatUserTime(date, timezone, format)).toBe(
        `Sunday, March 29th, 2026 - ${expectedTime}`,
      );
    }
    expect(formatUserTime(after, "Invalid/Timezone", "12")).toBeUndefined();
    expect(formatUserTime(after, "Europe/Vienna", "12")).toBe("Sunday, March 29th, 2026 - 3:30 AM");
  });
});
