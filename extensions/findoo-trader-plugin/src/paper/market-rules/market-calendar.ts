import { MARKET_REGISTRY } from "./markets/index.js";
import type { ExtendedMarketType } from "./types.js";

/** Resolve symbol to extended market type via suffix heuristic. */
export function resolveMarket(symbol: string): ExtendedMarketType {
  if (symbol.includes("/")) return "crypto";
  if (symbol.endsWith(".SH") || symbol.endsWith(".SZ")) return "cn_a_share";
  if (symbol.endsWith(".HK")) return "hk_equity";
  return "us_equity";
}

/** Check if a market is currently open. Uses real timezone-aware session checking. */
export function isMarketOpen(market: ExtendedMarketType, timestamp?: number): boolean {
  const def = MARKET_REGISTRY[market];
  if (!def) return false;
  if (def.sessions.length === 0) return true; // crypto: always open

  const ts = timestamp ?? Date.now();
  const date = new Date(ts);

  // Weekend check (for non-crypto)
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

export function getMarketTimezone(market: ExtendedMarketType): string {
  return MARKET_REGISTRY[market]?.timezone ?? "UTC";
}

function getLocalTime(date: Date, timezone: string): { hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return { hour, minute };
}

function getLocalDayOfWeek(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  });
  const dayStr = formatter.format(date);
  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return dayMap[dayStr] ?? 0;
}
