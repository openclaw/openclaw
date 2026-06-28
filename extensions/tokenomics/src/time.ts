// UTC time-bucketing helpers. All keys are computed in UTC so a ledger written
// in one timezone rolls up identically everywhere.

const DAY_MS = 24 * 60 * 60 * 1000;

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `YYYY-MM-DD` (UTC). */
export function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** `YYYY-MM` (UTC). */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** `YYYY` (UTC). */
export function yearKey(d: Date): string {
  return String(d.getUTCFullYear());
}

/** `YYYY-MM-DD HH:00` (UTC). */
export function hourKey(d: Date): string {
  return `${dayKey(d)} ${pad2(d.getUTCHours())}:00`;
}

/**
 * ISO-8601 week-year + week number for `d` (UTC), formatted `YYYY-Www`. The
 * week-year can differ from the calendar year near January/December (e.g.
 * 2026-01-01 may fall in 2025-W53).
 */
export function isoWeek(d: Date): { year: number; week: number } {
  // Thursday of the current week determines the ISO week-year.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const ftDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return { year: isoYear, week };
}

/** `YYYY-Www` (UTC, ISO-8601). */
export function weekKey(d: Date): string {
  const { year, week } = isoWeek(d);
  return `${year}-W${pad2(week)}`;
}

/** Midnight UTC at the start of `d`'s day. */
export function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Parse a flexible `YYYY-MM-DD` (UTC midnight). `endOfDay` snaps to 23:59:59. */
export function parseDate(s: string, endOfDay = false): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) {
    throw new Error(`bad date ${JSON.stringify(s)} (want YYYY-MM-DD)`);
  }
  const [, y, mo, da] = m;
  const year = Number(y);
  const month = Number(mo) - 1;
  const day = Number(da);
  const t = endOfDay ? Date.UTC(year, month, day, 23, 59, 59) : Date.UTC(year, month, day, 0, 0, 0);
  return new Date(t);
}

/** Days between two dates (>= 1). */
export function daysBetween(since: Date, until: Date): number {
  return Math.max(1, Math.floor((until.getTime() - since.getTime()) / DAY_MS));
}
