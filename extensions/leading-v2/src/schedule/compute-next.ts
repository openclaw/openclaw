import type { Schedule } from "./types.js";

/** Read the wall-clock Y/M/D and weekday of an instant in a given IANA tz. */
function tzDate(tz: string, epoch: number): { y: number; mo: number; d: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(epoch))) {
    map[p.type] = p.value;
  }
  return { y: Number(map.year), mo: Number(map.month), d: Number(map.day) };
}

/** Offset (ms) between the tz wall clock and UTC at a given instant (e.g. +8h for Shanghai). */
function tzOffsetMs(tz: string, epoch: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(epoch))) {
    map[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUtc - epoch;
}

/** Convert a wall-clock time in tz to an epoch ms (DST-safe with one refinement). */
function wallToEpoch(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offset = tzOffsetMs(tz, utcGuess);
  let epoch = utcGuess - offset;
  const offset2 = tzOffsetMs(tz, epoch);
  if (offset2 !== offset) {
    epoch = utcGuess - offset2;
  }
  return epoch;
}

/** Parse "HH:mm" → {h, m}; returns null if malformed. */
export function parseHm(time: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) {
    return null;
  }
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return { h, m };
}

/**
 * Next fire time (epoch ms) strictly after `from`, in the task's tz.
 * - interval: from + everyMinutes
 * - daily:    next HH:mm in tz
 * - weekly:   next HH:mm in tz on the given weekday (0=Sun..6=Sat)
 */
export function computeNext(schedule: Schedule, from: number, tz: string): number {
  if (schedule.kind === "interval") {
    const ms = Math.max(1, Math.floor(schedule.everyMinutes)) * 60_000;
    return from + ms;
  }

  const hm = parseHm(schedule.time);
  if (!hm) {
    // Malformed time — push a day out so a bad schedule can't hot-loop.
    return from + 86_400_000;
  }
  const { y, mo, d } = tzDate(tz, from);
  for (let i = 0; i <= 8; i++) {
    // Roll the calendar date forward i days (UTC midnight handles month/year wrap);
    // weekday is date-only so getUTCDay on that midnight is correct.
    const dayUtc = Date.UTC(y, mo - 1, d + i);
    const cal = new Date(dayUtc);
    if (schedule.kind === "weekly" && cal.getUTCDay() !== schedule.weekday) {
      continue;
    }
    const epoch = wallToEpoch(
      tz,
      cal.getUTCFullYear(),
      cal.getUTCMonth() + 1,
      cal.getUTCDate(),
      hm.h,
      hm.m,
    );
    if (epoch > from) {
      return epoch;
    }
  }
  // Unreachable for valid input; fall back to +1 day.
  return from + 86_400_000;
}
