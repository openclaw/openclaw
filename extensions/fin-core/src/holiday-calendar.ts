/**
 * Holiday calendar for multi-market trading.
 * Defines exchange holidays and half-days for US, HK, CN, and crypto markets.
 * Data is manually curated per year — add new years as needed.
 */
import type { MarketType } from "./types.js";

export interface HolidayEntry {
  /** ISO date string "YYYY-MM-DD" */
  date: string;
  name: string;
}

// ── Holiday Data (keyed by market → year) ──

type HolidayRegistry = Record<string, Record<number, HolidayEntry[]>>;

const HOLIDAYS: HolidayRegistry = {
  "us-equity": {
    2026: [
      { date: "2026-01-01", name: "New Year's Day" },
      { date: "2026-01-19", name: "Martin Luther King Jr. Day" },
      { date: "2026-02-16", name: "Presidents' Day" },
      { date: "2026-04-03", name: "Good Friday" },
      { date: "2026-05-25", name: "Memorial Day" },
      { date: "2026-06-19", name: "Juneteenth" },
      { date: "2026-07-03", name: "Independence Day (observed)" },
      { date: "2026-09-07", name: "Labor Day" },
      { date: "2026-11-26", name: "Thanksgiving" },
      { date: "2026-12-25", name: "Christmas Day" },
    ],
  },
  "hk-equity": {
    2026: [
      { date: "2026-01-01", name: "New Year's Day" },
      { date: "2026-02-17", name: "Lunar New Year Day 1" },
      { date: "2026-02-18", name: "Lunar New Year Day 2" },
      { date: "2026-02-19", name: "Lunar New Year Day 3" },
      { date: "2026-04-03", name: "Good Friday" },
      { date: "2026-04-04", name: "Ching Ming Festival" },
      { date: "2026-04-06", name: "Easter Monday" },
      { date: "2026-05-01", name: "Labour Day" },
      { date: "2026-05-24", name: "Birthday of the Buddha" },
      { date: "2026-06-19", name: "Tuen Ng Festival" },
      { date: "2026-07-01", name: "HKSAR Establishment Day" },
      { date: "2026-10-01", name: "National Day" },
      { date: "2026-10-07", name: "Chung Yeung Festival" },
      { date: "2026-12-25", name: "Christmas Day" },
    ],
  },
  "cn-a-share": {
    2026: [
      { date: "2026-01-01", name: "New Year's Day" },
      { date: "2026-01-02", name: "New Year's Day (extended)" },
      { date: "2026-02-16", name: "Spring Festival Eve" },
      { date: "2026-02-17", name: "Spring Festival Day 1" },
      { date: "2026-02-18", name: "Spring Festival Day 2" },
      { date: "2026-02-19", name: "Spring Festival Day 3" },
      { date: "2026-02-20", name: "Spring Festival Day 4" },
      { date: "2026-04-04", name: "Qingming Festival" },
      { date: "2026-05-01", name: "Labour Day" },
      { date: "2026-05-02", name: "Labour Day (extended)" },
      { date: "2026-05-05", name: "Labour Day (extended)" },
      { date: "2026-06-19", name: "Dragon Boat Festival" },
      { date: "2026-10-01", name: "National Day" },
      { date: "2026-10-02", name: "National Day (extended)" },
      { date: "2026-10-05", name: "National Day (extended)" },
      { date: "2026-10-06", name: "Mid-Autumn Festival" },
      { date: "2026-10-07", name: "National Day (extended)" },
    ],
  },
};

// US half-day dates (early close at 13:00 ET)
const US_HALF_DAYS: Record<number, string[]> = {
  2026: [
    "2026-11-27", // Day after Thanksgiving
    "2026-12-24", // Christmas Eve
  ],
};

// ── Internal helpers ──

/** Format a Date as "YYYY-MM-DD" in the market's local timezone. */
function toDateString(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

/** Map market to its reference timezone for date comparison. */
function marketTimezone(market: MarketType): string {
  switch (market) {
    case "us-equity": return "America/New_York";
    case "hk-equity": return "Asia/Hong_Kong";
    case "cn-a-share": return "Asia/Shanghai";
    default: return "UTC";
  }
}

// ── Public API ──

/**
 * Check if a given date is a full-day holiday for the specified market.
 * Date is evaluated in the market's local timezone.
 */
export function isHoliday(market: MarketType, date: Date): boolean {
  if (market === "crypto") return false;

  const tz = marketTimezone(market);
  const dateStr = toDateString(date, tz);
  const year = parseInt(dateStr.substring(0, 4), 10);
  const holidays = HOLIDAYS[market]?.[year];
  if (!holidays) return false;

  return holidays.some((h) => h.date === dateStr);
}

/**
 * Check if a given date is a half-day (early close) for the specified market.
 * Currently only US equity has half-days.
 */
export function isHalfDay(market: MarketType, date: Date): boolean {
  if (market !== "us-equity") return false;

  const tz = marketTimezone(market);
  const dateStr = toDateString(date, tz);
  const year = parseInt(dateStr.substring(0, 4), 10);
  const halfDays = US_HALF_DAYS[year];
  if (!halfDays) return false;

  return halfDays.includes(dateStr);
}

/**
 * Get all holidays for a market in a given year.
 * Returns empty array for crypto or unsupported years.
 */
export function getHolidays(market: MarketType, year: number): HolidayEntry[] {
  if (market === "crypto") return [];
  return HOLIDAYS[market]?.[year] ?? [];
}
