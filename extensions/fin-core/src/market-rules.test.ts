import { describe, expect, it } from "vitest";
import { getMarketTimezone, isMarketOpen, resolveMarket, validateLotSize, getEarlyCloseTime } from "./market-rules.js";

describe("resolveMarket", () => {
  it("resolves crypto symbols (contains /)", () => {
    expect(resolveMarket("BTC/USDT")).toBe("crypto");
    expect(resolveMarket("ETH/BTC")).toBe("crypto");
  });

  it("resolves HK symbols (ends with .HK)", () => {
    expect(resolveMarket("0700.HK")).toBe("hk-equity");
    expect(resolveMarket("9988.HK")).toBe("hk-equity");
  });

  it("resolves US symbols (default)", () => {
    expect(resolveMarket("AAPL")).toBe("us-equity");
    expect(resolveMarket("TSLA")).toBe("us-equity");
    expect(resolveMarket("GOOGL")).toBe("us-equity");
  });

  it("resolves A-share symbols (.SS for Shanghai, .SZ for Shenzhen)", () => {
    expect(resolveMarket("600519.SS")).toBe("cn-a-share");
    expect(resolveMarket("000858.SZ")).toBe("cn-a-share");
    expect(resolveMarket("300750.SZ")).toBe("cn-a-share");
    expect(resolveMarket("601318.SH")).toBe("cn-a-share");
  });
});

describe("isMarketOpen", () => {
  it("crypto is always open", () => {
    // Any timestamp — crypto never closes
    expect(isMarketOpen("crypto", Date.UTC(2026, 2, 3, 3, 0))).toBe(true); // 3am UTC Monday
    expect(isMarketOpen("crypto", Date.UTC(2026, 2, 7, 12, 0))).toBe(true); // Saturday
    expect(isMarketOpen("crypto", Date.UTC(2026, 2, 8, 0, 0))).toBe(true); // Sunday
  });

  it("US market open during trading hours (Mon-Fri 9:30-16:00 ET)", () => {
    // 2026-03-03 is a Tuesday
    // 10:00 ET = 15:00 UTC (EST = UTC-5)
    const tuesMidSession = Date.UTC(2026, 2, 3, 15, 0);
    expect(isMarketOpen("us-equity", tuesMidSession)).toBe(true);
  });

  it("US market closed outside hours", () => {
    // 2026-03-03 Tuesday, 8:00 ET = 13:00 UTC (before 9:30 ET)
    const tuesBeforeOpen = Date.UTC(2026, 2, 3, 13, 0);
    expect(isMarketOpen("us-equity", tuesBeforeOpen)).toBe(false);

    // 2026-03-03 Tuesday, 17:00 ET = 22:00 UTC (after 16:00 ET)
    const tuesAfterClose = Date.UTC(2026, 2, 3, 22, 0);
    expect(isMarketOpen("us-equity", tuesAfterClose)).toBe(false);
  });

  it("US market closed on weekends", () => {
    // 2026-03-07 is a Saturday, 12:00 ET = 17:00 UTC
    const saturday = Date.UTC(2026, 2, 7, 17, 0);
    expect(isMarketOpen("us-equity", saturday)).toBe(false);
  });

  it("HK market has lunch break (12:00-13:00)", () => {
    // 2026-03-03 Tuesday
    // Morning session: 9:30-12:00 HKT (HKT = UTC+8)
    // 10:00 HKT = 02:00 UTC
    const hkMorning = Date.UTC(2026, 2, 3, 2, 0);
    expect(isMarketOpen("hk-equity", hkMorning)).toBe(true);

    // Lunch break: 12:30 HKT = 04:30 UTC
    const hkLunch = Date.UTC(2026, 2, 3, 4, 30);
    expect(isMarketOpen("hk-equity", hkLunch)).toBe(false);

    // Afternoon session: 14:00 HKT = 06:00 UTC
    const hkAfternoon = Date.UTC(2026, 2, 3, 6, 0);
    expect(isMarketOpen("hk-equity", hkAfternoon)).toBe(true);
  });

  // ── CN A-Share ──

  it("CN A-share open during morning session (9:30-11:30 CST)", () => {
    // 2026-03-03 Tuesday, 10:00 CST = 02:00 UTC
    const cnMorning = Date.UTC(2026, 2, 3, 2, 0);
    expect(isMarketOpen("cn-a-share", cnMorning)).toBe(true);
  });

  it("CN A-share closed during lunch break (11:30-13:00 CST)", () => {
    // 2026-03-03 Tuesday, 12:00 CST = 04:00 UTC
    const cnLunch = Date.UTC(2026, 2, 3, 4, 0);
    expect(isMarketOpen("cn-a-share", cnLunch)).toBe(false);
  });

  it("CN A-share open during afternoon session (13:00-15:00 CST)", () => {
    // 2026-03-03 Tuesday, 14:00 CST = 06:00 UTC
    const cnAfternoon = Date.UTC(2026, 2, 3, 6, 0);
    expect(isMarketOpen("cn-a-share", cnAfternoon)).toBe(true);
  });

  it("CN A-share closed after 15:00 CST", () => {
    // 2026-03-03 Tuesday, 15:30 CST = 07:30 UTC
    const cnAfterClose = Date.UTC(2026, 2, 3, 7, 30);
    expect(isMarketOpen("cn-a-share", cnAfterClose)).toBe(false);
  });

  it("CN A-share closed on weekends", () => {
    // 2026-03-07 Saturday, 10:00 CST = 02:00 UTC
    const saturday = Date.UTC(2026, 2, 7, 2, 0);
    expect(isMarketOpen("cn-a-share", saturday)).toBe(false);
  });

  it("CN A-share closed on Spring Festival", () => {
    // 2026-02-17 Tuesday (Spring Festival Day 1), 10:00 CST = 02:00 UTC
    const springFestival = Date.UTC(2026, 1, 17, 2, 0);
    expect(isMarketOpen("cn-a-share", springFestival)).toBe(false);
  });

  // ── Holiday integration ──

  it("US market closed on Thanksgiving", () => {
    // 2026-11-26 Thursday (Thanksgiving), 11:00 ET = 16:00 UTC
    const thanksgiving = Date.UTC(2026, 10, 26, 16, 0);
    expect(isMarketOpen("us-equity", thanksgiving)).toBe(false);
  });

  it("US market half-day: day after Thanksgiving closes at 13:00 ET", () => {
    // 2026-11-27 Friday (half day), 12:00 ET = 17:00 UTC — should be open
    const halfDayMorning = Date.UTC(2026, 10, 27, 17, 0);
    expect(isMarketOpen("us-equity", halfDayMorning)).toBe(true);

    // 2026-11-27 Friday (half day), 14:00 ET = 19:00 UTC — should be closed
    const halfDayAfternoon = Date.UTC(2026, 10, 27, 19, 0);
    expect(isMarketOpen("us-equity", halfDayAfternoon)).toBe(false);
  });

  it("HK market closed on Lunar New Year", () => {
    // 2026-02-17 Lunar New Year Day 1, 10:00 HKT = 02:00 UTC
    const lunarNewYear = Date.UTC(2026, 1, 17, 2, 0);
    expect(isMarketOpen("hk-equity", lunarNewYear)).toBe(false);
  });
});

describe("getMarketTimezone", () => {
  it("returns correct timezones", () => {
    expect(getMarketTimezone("crypto")).toBe("UTC");
    expect(getMarketTimezone("us-equity")).toBe("America/New_York");
    expect(getMarketTimezone("hk-equity")).toBe("Asia/Hong_Kong");
    expect(getMarketTimezone("cn-a-share")).toBe("Asia/Shanghai");
  });
});

describe("getEarlyCloseTime", () => {
  // Use midday UTC to ensure correct timezone resolution
  it("returns 13:00 for US half days", () => {
    const result = getEarlyCloseTime("us-equity", new Date("2026-11-27T12:00:00Z"));
    expect(result).toEqual({ hour: 13, minute: 0 });
  });

  it("returns null for regular trading days", () => {
    expect(getEarlyCloseTime("us-equity", new Date("2026-03-03T12:00:00Z"))).toBeNull();
  });

  it("returns null for non-US markets", () => {
    expect(getEarlyCloseTime("cn-a-share", new Date("2026-11-27T12:00:00Z"))).toBeNull();
    expect(getEarlyCloseTime("crypto", new Date("2026-11-27T12:00:00Z"))).toBeNull();
  });
});

describe("validateLotSize", () => {
  it("crypto has no lot size restriction", () => {
    expect(validateLotSize("crypto", "buy", 0.0001)).toEqual({ valid: true });
    expect(validateLotSize("crypto", "sell", 123.456)).toEqual({ valid: true });
  });

  it("US equity has no multiple restriction", () => {
    expect(validateLotSize("us-equity", "buy", 1)).toEqual({ valid: true });
    expect(validateLotSize("us-equity", "buy", 7)).toEqual({ valid: true });
    expect(validateLotSize("us-equity", "sell", 3)).toEqual({ valid: true });
  });

  it("HK equity buy must be multiple of 100", () => {
    expect(validateLotSize("hk-equity", "buy", 100)).toEqual({ valid: true });
    expect(validateLotSize("hk-equity", "buy", 500)).toEqual({ valid: true });

    const result = validateLotSize("hk-equity", "buy", 50);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("multiple of 100");
  });

  it("HK equity sell can be odd lots", () => {
    expect(validateLotSize("hk-equity", "sell", 50)).toEqual({ valid: true });
    expect(validateLotSize("hk-equity", "sell", 1)).toEqual({ valid: true });
  });

  it("CN A-share buy must be multiple of 100 (一手)", () => {
    expect(validateLotSize("cn-a-share", "buy", 100)).toEqual({ valid: true });
    expect(validateLotSize("cn-a-share", "buy", 500)).toEqual({ valid: true });

    const result = validateLotSize("cn-a-share", "buy", 50);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("multiple of 100");
  });

  it("CN A-share sell can be odd lots", () => {
    expect(validateLotSize("cn-a-share", "sell", 50)).toEqual({ valid: true });
    expect(validateLotSize("cn-a-share", "sell", 1)).toEqual({ valid: true });
  });
});
