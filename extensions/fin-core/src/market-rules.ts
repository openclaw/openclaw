/**
 * Market rules for fin-core — trading hours, lot sizes, symbol resolution.
 * Covers 4 markets: crypto, US equity, HK equity, CN A-share.
 * Includes holiday calendar integration for accurate open/close detection.
 */
import type { MarketType } from "./types.js";
import { isHalfDay, isHoliday } from "./holiday-calendar.js";

// ── Types ──

export interface TradingSession {
  open: { hour: number; minute: number };
  close: { hour: number; minute: number };
}

export interface LotSizeRule {
  minLot: number;
  buyMustBeMultiple: boolean;
}

interface MarketDefinition {
  type: MarketType;
  timezone: string;
  sessions: TradingSession[];
  lotSize: LotSizeRule;
}

// ── Market Definitions ──

const CRYPTO: MarketDefinition = {
  type: "crypto",
  timezone: "UTC",
  sessions: [], // 24/7
  lotSize: { minLot: 0, buyMustBeMultiple: false },
};

const US_EQUITY: MarketDefinition = {
  type: "us-equity",
  timezone: "America/New_York",
  sessions: [{ open: { hour: 9, minute: 30 }, close: { hour: 16, minute: 0 } }],
  lotSize: { minLot: 1, buyMustBeMultiple: false },
};

const HK_EQUITY: MarketDefinition = {
  type: "hk-equity",
  timezone: "Asia/Hong_Kong",
  sessions: [
    { open: { hour: 9, minute: 30 }, close: { hour: 12, minute: 0 } },
    { open: { hour: 13, minute: 0 }, close: { hour: 16, minute: 0 } },
  ],
  lotSize: { minLot: 100, buyMustBeMultiple: true },
};

const CN_A_SHARE: MarketDefinition = {
  type: "cn-a-share",
  timezone: "Asia/Shanghai",
  sessions: [
    { open: { hour: 9, minute: 30 }, close: { hour: 11, minute: 30 } },
    { open: { hour: 13, minute: 0 }, close: { hour: 15, minute: 0 } },
  ],
  lotSize: { minLot: 100, buyMustBeMultiple: true },
};

const MARKET_REGISTRY: Record<MarketType, MarketDefinition> = {
  crypto: CRYPTO,
  "us-equity": US_EQUITY,
  "hk-equity": HK_EQUITY,
  "cn-a-share": CN_A_SHARE,
};

// ── Public API ──

/** Resolve a symbol to its MarketType using suffix heuristics. */
export function resolveMarket(symbol: string): MarketType {
  if (symbol.includes("/")) return "crypto";
  if (symbol.endsWith(".HK")) return "hk-equity";
  if (symbol.endsWith(".SS") || symbol.endsWith(".SZ") || symbol.endsWith(".SH")) return "cn-a-share";
  return "us-equity"; // default for plain tickers like AAPL, TSLA
}

/** Check if a market is currently open. Timezone-aware with holiday + half-day support. */
export function isMarketOpen(market: MarketType, timestamp?: number): boolean {
  const def = MARKET_REGISTRY[market];
  if (!def) return false;
  if (def.sessions.length === 0) return true; // crypto: always open

  const date = new Date(timestamp ?? Date.now());

  // Weekend check
  const dayInTz = getLocalDayOfWeek(date, def.timezone);
  if (dayInTz === 0 || dayInTz === 6) return false;

  // Holiday check
  if (isHoliday(market, date)) return false;

  const { hour, minute } = getLocalTime(date, def.timezone);
  const currentMinutes = hour * 60 + minute;

  // Half-day check: override close time for the last session
  const earlyClose = getEarlyCloseTime(market, date);

  return def.sessions.some((session, idx) => {
    const openMinutes = session.open.hour * 60 + session.open.minute;
    let closeMinutes = session.close.hour * 60 + session.close.minute;

    // Apply early close to the first session only (US half-day closes at 13:00)
    if (earlyClose && idx === 0) {
      const earlyCloseMinutes = earlyClose.hour * 60 + earlyClose.minute;
      closeMinutes = Math.min(closeMinutes, earlyCloseMinutes);
    }
    // On half days, afternoon sessions don't exist
    if (earlyClose && idx > 0) return false;

    return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
  });
}

/** Get early close time for half-day sessions. Returns null for regular days. */
export function getEarlyCloseTime(
  market: MarketType,
  date: Date,
): { hour: number; minute: number } | null {
  if (!isHalfDay(market, date)) return null;
  // US half-day closes at 13:00 ET
  if (market === "us-equity") return { hour: 13, minute: 0 };
  return null;
}

/** Get the IANA timezone for a market. */
export function getMarketTimezone(market: MarketType): string {
  return MARKET_REGISTRY[market]?.timezone ?? "UTC";
}

/** Validate lot size for a given market and side. */
export function validateLotSize(
  market: MarketType,
  side: "buy" | "sell",
  quantity: number,
): { valid: boolean; reason?: string } {
  const def = MARKET_REGISTRY[market];
  if (!def) return { valid: true };

  const rule = def.lotSize;
  if (rule.minLot === 0) return { valid: true };

  // Only buy orders need multiple check (sell can be odd lots)
  if (side === "buy" && rule.buyMustBeMultiple && quantity % rule.minLot !== 0) {
    return {
      valid: false,
      reason: `${market} buy quantity must be a multiple of ${rule.minLot}, got ${quantity}`,
    };
  }

  return { valid: true };
}

// ── Internal helpers ──

function getLocalTime(date: Date, timezone: string): { hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  return {
    hour: Number(parts.find((p) => p.type === "hour")?.value ?? 0),
    minute: Number(parts.find((p) => p.type === "minute")?.value ?? 0),
  };
}

function getLocalDayOfWeek(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  });
  const dayStr = formatter.format(date);
  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return dayMap[dayStr] ?? 0;
}
