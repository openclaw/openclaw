/**
 * Market rules for fin-core — trading hours, lot sizes, symbol resolution.
 * Simplified version of fin-paper-trading's market-rules module.
 * Covers the 3 markets fin-core supports: crypto, US equity, HK equity.
 */
import type { MarketType } from "./types.js";

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

const MARKET_REGISTRY: Record<MarketType, MarketDefinition> = {
  crypto: CRYPTO,
  "us-equity": US_EQUITY,
  "hk-equity": HK_EQUITY,
};

// ── Public API ──

/** Resolve a symbol to its MarketType using suffix heuristics. */
export function resolveMarket(symbol: string): MarketType {
  if (symbol.includes("/")) return "crypto";
  if (symbol.endsWith(".HK")) return "hk-equity";
  return "us-equity"; // default for plain tickers like AAPL, TSLA
}

/** Check if a market is currently open. Timezone-aware session checking. */
export function isMarketOpen(market: MarketType, timestamp?: number): boolean {
  const def = MARKET_REGISTRY[market];
  if (!def) return false;
  if (def.sessions.length === 0) return true; // crypto: always open

  const date = new Date(timestamp ?? Date.now());

  // Weekend check
  const dayInTz = getLocalDayOfWeek(date, def.timezone);
  if (dayInTz === 0 || dayInTz === 6) return false;

  const { hour, minute } = getLocalTime(date, def.timezone);
  const currentMinutes = hour * 60 + minute;

  return def.sessions.some((session) => {
    const openMinutes = session.open.hour * 60 + session.open.minute;
    const closeMinutes = session.close.hour * 60 + session.close.minute;
    return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
  });
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
