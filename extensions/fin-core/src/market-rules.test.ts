import { describe, expect, it } from "vitest";
import { getMarketTimezone, isMarketOpen, resolveMarket, validateLotSize } from "./market-rules.js";

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
});

describe("getMarketTimezone", () => {
  it("returns correct timezones", () => {
    expect(getMarketTimezone("crypto")).toBe("UTC");
    expect(getMarketTimezone("us-equity")).toBe("America/New_York");
    expect(getMarketTimezone("hk-equity")).toBe("Asia/Hong_Kong");
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
});
