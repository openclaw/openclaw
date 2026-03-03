import { describe, expect, it } from "vitest";
import { getHolidays, getLatestHolidayYear, isHalfDay, isHoliday, isHolidayDataStale, isMakeupTradingDay } from "./holiday-calendar.js";
import type { MarketType } from "./types.js";

/**
 * Helper: create a Date at midday UTC for a given date string.
 * new Date("2026-01-01") = midnight UTC which is Dec 31 in US Eastern,
 * so we use midday to ensure the date resolves correctly in all timezones.
 */
function midday(dateStr: string): Date {
  return new Date(`${dateStr}T12:00:00Z`);
}

describe("isHoliday", () => {
  // ── Crypto: no holidays ever ──
  it("crypto has no holidays", () => {
    expect(isHoliday("crypto", midday("2026-01-01"))).toBe(false);
    expect(isHoliday("crypto", midday("2026-12-25"))).toBe(false);
  });

  // ── US Equity (NYSE) 2026 holidays ──
  describe("US equity 2026 holidays", () => {
    const usHolidays2026 = [
      ["2026-01-01", "New Year's Day"],
      ["2026-01-19", "Martin Luther King Jr. Day"],
      ["2026-02-16", "Presidents' Day"],
      ["2026-04-03", "Good Friday"],
      ["2026-05-25", "Memorial Day"],
      ["2026-06-19", "Juneteenth"],
      ["2026-07-03", "Independence Day (observed)"],
      ["2026-09-07", "Labor Day"],
      ["2026-11-26", "Thanksgiving"],
      ["2026-12-25", "Christmas Day"],
    ] as const;

    for (const [date, name] of usHolidays2026) {
      it(`${name} (${date}) is a holiday`, () => {
        expect(isHoliday("us-equity", midday(date))).toBe(true);
      });
    }

    it("regular trading day is not a holiday", () => {
      expect(isHoliday("us-equity", midday("2026-03-03"))).toBe(false);
      expect(isHoliday("us-equity", midday("2026-06-15"))).toBe(false);
    });
  });

  // ── HK Equity (HKEX) 2026 holidays ──
  describe("HK equity 2026 holidays", () => {
    const hkHolidays2026 = [
      ["2026-01-01", "New Year's Day"],
      ["2026-02-17", "Lunar New Year Day 1"],
      ["2026-02-18", "Lunar New Year Day 2"],
      ["2026-02-19", "Lunar New Year Day 3"],
      ["2026-04-04", "Ching Ming Festival"],
      ["2026-04-03", "Good Friday"],
      ["2026-04-06", "Easter Monday"],
      ["2026-05-01", "Labour Day"],
      ["2026-05-24", "Birthday of the Buddha"],
      ["2026-06-19", "Tuen Ng Festival"],
      ["2026-07-01", "HKSAR Establishment Day"],
      ["2026-10-01", "National Day"],
      ["2026-10-07", "Chung Yeung Festival"],
      ["2026-12-25", "Christmas Day"],
    ] as const;

    for (const [date, name] of hkHolidays2026) {
      it(`${name} (${date}) is a holiday`, () => {
        expect(isHoliday("hk-equity", midday(date))).toBe(true);
      });
    }

    it("regular trading day is not a holiday", () => {
      expect(isHoliday("hk-equity", midday("2026-03-03"))).toBe(false);
    });
  });

  // ── CN A-Share (SSE/SZSE) 2026 holidays ──
  describe("CN A-share 2026 holidays", () => {
    const cnHolidays2026 = [
      ["2026-01-01", "New Year's Day"],
      ["2026-01-02", "New Year's Day (extended)"],
      ["2026-02-16", "Spring Festival Eve"],
      ["2026-02-17", "Spring Festival Day 1"],
      ["2026-02-18", "Spring Festival Day 2"],
      ["2026-02-19", "Spring Festival Day 3"],
      ["2026-02-20", "Spring Festival Day 4"],
      ["2026-04-04", "Qingming Festival"],
      ["2026-05-01", "Labour Day"],
      ["2026-05-02", "Labour Day (extended)"],
      ["2026-05-05", "Labour Day (extended)"],
      ["2026-06-19", "Dragon Boat Festival"],
      ["2026-10-01", "National Day"],
      ["2026-10-02", "National Day (extended)"],
      ["2026-10-05", "National Day (extended)"],
      ["2026-10-06", "Mid-Autumn Festival"],
      ["2026-10-07", "National Day (extended)"],
    ] as const;

    for (const [date, name] of cnHolidays2026) {
      it(`${name} (${date}) is a holiday`, () => {
        expect(isHoliday("cn-a-share", midday(date))).toBe(true);
      });
    }

    it("regular trading day is not a holiday", () => {
      expect(isHoliday("cn-a-share", midday("2026-03-03"))).toBe(false);
    });
  });
});

describe("isHalfDay", () => {
  it("crypto has no half days", () => {
    expect(isHalfDay("crypto", midday("2026-11-27"))).toBe(false);
  });

  it("US equity: day after Thanksgiving is a half day", () => {
    expect(isHalfDay("us-equity", midday("2026-11-27"))).toBe(true);
  });

  it("US equity: Christmas Eve is a half day", () => {
    expect(isHalfDay("us-equity", midday("2026-12-24"))).toBe(true);
  });

  it("US equity: regular day is not a half day", () => {
    expect(isHalfDay("us-equity", midday("2026-03-03"))).toBe(false);
  });

  it("HK/CN markets have no half days", () => {
    expect(isHalfDay("hk-equity", midday("2026-12-24"))).toBe(false);
    expect(isHalfDay("cn-a-share", midday("2026-12-24"))).toBe(false);
  });
});

describe("getHolidays", () => {
  it("returns holiday list for a given market and year", () => {
    const usHolidays = getHolidays("us-equity", 2026);
    expect(usHolidays.length).toBeGreaterThanOrEqual(9);
    expect(usHolidays.some((h) => h.date === "2026-12-25")).toBe(true);
  });

  it("returns empty for crypto", () => {
    expect(getHolidays("crypto", 2026)).toEqual([]);
  });

  it("returns holidays for cn-a-share", () => {
    const cnHolidays = getHolidays("cn-a-share", 2026);
    expect(cnHolidays.length).toBeGreaterThanOrEqual(15);
  });

  it("returns empty for unsupported year (far future)", () => {
    const future = getHolidays("us-equity", 2099);
    expect(future).toEqual([]);
  });

  it("returns 2027 US holidays (10 entries)", () => {
    const holidays = getHolidays("us-equity", 2027);
    expect(holidays).toHaveLength(10);
    expect(holidays.some((h) => h.date === "2027-01-01")).toBe(true);
    expect(holidays.some((h) => h.date === "2027-12-24")).toBe(true);
  });

  it("returns 2027 HK holidays (≥14 entries)", () => {
    const holidays = getHolidays("hk-equity", 2027);
    expect(holidays.length).toBeGreaterThanOrEqual(14);
    expect(holidays.some((h) => h.date === "2027-02-06")).toBe(true); // Lunar New Year Eve
  });

  it("returns 2027 CN holidays (≥17 entries)", () => {
    const holidays = getHolidays("cn-a-share", 2027);
    expect(holidays.length).toBeGreaterThanOrEqual(17);
    expect(holidays.some((h) => h.date === "2027-02-07")).toBe(true); // Spring Festival
    expect(holidays.some((h) => h.date === "2027-10-01")).toBe(true); // National Day
  });
});

describe("2027 holiday verification", () => {
  describe("US equity 2027 holidays", () => {
    const usHolidays2027 = [
      ["2027-01-01", "New Year's Day"],
      ["2027-01-18", "Martin Luther King Jr. Day"],
      ["2027-02-15", "Presidents' Day"],
      ["2027-03-26", "Good Friday"],
      ["2027-05-31", "Memorial Day"],
      ["2027-06-18", "Juneteenth (observed)"],
      ["2027-07-05", "Independence Day (observed)"],
      ["2027-09-06", "Labor Day"],
      ["2027-11-25", "Thanksgiving"],
      ["2027-12-24", "Christmas Day (observed)"],
    ] as const;

    for (const [date, name] of usHolidays2027) {
      it(`${name} (${date}) is a holiday`, () => {
        expect(isHoliday("us-equity", midday(date))).toBe(true);
      });
    }
  });

  describe("HK equity 2027 holidays", () => {
    it("Lunar New Year Eve 2027-02-06 is a holiday", () => {
      expect(isHoliday("hk-equity", midday("2027-02-06"))).toBe(true);
    });

    it("HKSAR Establishment Day 2027-07-01 is a holiday", () => {
      expect(isHoliday("hk-equity", midday("2027-07-01"))).toBe(true);
    });
  });

  describe("CN A-share 2027 holidays", () => {
    it("Spring Festival 2027-02-07 is a holiday", () => {
      expect(isHoliday("cn-a-share", midday("2027-02-07"))).toBe(true);
    });

    it("National Day 2027-10-01 is a holiday", () => {
      expect(isHoliday("cn-a-share", midday("2027-10-01"))).toBe(true);
    });

    it("regular 2027 trading day is not a holiday", () => {
      expect(isHoliday("cn-a-share", midday("2027-03-15"))).toBe(false);
    });
  });

  it("US 2027 half-days", () => {
    expect(isHalfDay("us-equity", midday("2027-11-26"))).toBe(true);
    expect(isHalfDay("us-equity", midday("2027-12-23"))).toBe(true);
    expect(isHalfDay("us-equity", midday("2027-03-15"))).toBe(false);
  });
});

describe("getLatestHolidayYear", () => {
  it("returns 2027 for all traditional markets", () => {
    expect(getLatestHolidayYear("us-equity")).toBe(2027);
    expect(getLatestHolidayYear("hk-equity")).toBe(2027);
    expect(getLatestHolidayYear("cn-a-share")).toBe(2027);
  });

  it("returns 0 for crypto", () => {
    expect(getLatestHolidayYear("crypto")).toBe(0);
  });
});

describe("isHolidayDataStale", () => {
  it("not stale when latest year is ahead of current", () => {
    // Pretend it's 2026 — we have 2027 data, so not stale
    expect(isHolidayDataStale("us-equity", new Date("2026-06-15"))).toBe(false);
    expect(isHolidayDataStale("hk-equity", new Date("2026-06-15"))).toBe(false);
    expect(isHolidayDataStale("cn-a-share", new Date("2026-06-15"))).toBe(false);
  });

  it("stale when current year equals latest year", () => {
    // Pretend it's 2027 — latest data is 2027, so stale (no 2028 data)
    expect(isHolidayDataStale("us-equity", new Date("2027-01-01"))).toBe(true);
    expect(isHolidayDataStale("hk-equity", new Date("2027-06-15"))).toBe(true);
  });

  it("stale when current year exceeds latest year", () => {
    expect(isHolidayDataStale("us-equity", new Date("2028-01-01"))).toBe(true);
  });

  it("crypto is never stale", () => {
    expect(isHolidayDataStale("crypto")).toBe(false);
    expect(isHolidayDataStale("crypto", new Date("2099-01-01"))).toBe(false);
  });
});

describe("isMakeupTradingDay", () => {
  it("2026 Spring Festival makeup Saturdays are trading days", () => {
    expect(isMakeupTradingDay("cn-a-share", midday("2026-02-14"))).toBe(true);
    expect(isMakeupTradingDay("cn-a-share", midday("2026-02-15"))).toBe(true);
  });

  it("2026 Labour Day makeup Saturday", () => {
    expect(isMakeupTradingDay("cn-a-share", midday("2026-04-26"))).toBe(true);
  });

  it("2026 National Day makeup weekends", () => {
    expect(isMakeupTradingDay("cn-a-share", midday("2026-09-27"))).toBe(true);
    expect(isMakeupTradingDay("cn-a-share", midday("2026-10-10"))).toBe(true);
  });

  it("2027 makeup days are recognized", () => {
    expect(isMakeupTradingDay("cn-a-share", midday("2027-01-03"))).toBe(true);
    expect(isMakeupTradingDay("cn-a-share", midday("2027-02-20"))).toBe(true);
  });

  it("regular Saturday is NOT a makeup day", () => {
    expect(isMakeupTradingDay("cn-a-share", midday("2026-03-07"))).toBe(false);
  });

  it("weekday is NOT a makeup day", () => {
    expect(isMakeupTradingDay("cn-a-share", midday("2026-03-03"))).toBe(false);
  });

  it("non-CN markets never have makeup days", () => {
    expect(isMakeupTradingDay("us-equity", midday("2026-02-14"))).toBe(false);
    expect(isMakeupTradingDay("hk-equity", midday("2026-02-14"))).toBe(false);
    expect(isMakeupTradingDay("crypto", midday("2026-02-14"))).toBe(false);
  });
});
