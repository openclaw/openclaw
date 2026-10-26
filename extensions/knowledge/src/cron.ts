/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week)
 * evaluated in an IANA time zone. Supports *, numbers, ranges, lists and
 * steps; day-of-month and day-of-week combine with cron's OR rule when both
 * are restricted. Only the Knowledge maintenance schedule uses this.
 */
type Field = { values: Set<number>; any: boolean };
export type Cron = {
  expr: string;
  timeZone: string;
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
};
type Wall = {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
  key: string;
};

const MINUTE = 60_000;
const BOUNDS: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function field(source: string, [min, max]: [number, number]): Field {
  const values = new Set<number>();
  for (const part of source.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) {
      throw new Error(`Invalid cron field "${source}".`);
    }
    const step = match[4] ? Number(match[4]) : 1;
    const from = match[1] === "*" ? min : Number(match[2]),
      to = match[1] === "*" ? max : match[3] ? Number(match[3]) : match[4] ? max : from;
    if (step < 1 || from < min || to > max || from > to) {
      throw new Error(`Invalid cron field "${source}".`);
    }
    for (let v = from; v <= to; v += step) {
      values.add(v);
    }
  }
  return { values, any: source === "*" };
}

/** Parse and validate an expression and time zone; throws a readable error. */
export function parseCron(expr: string, timeZone: string): Cron {
  const parts = expr.trim().split(/\s+/u);
  if (parts.length !== 5) {
    throw new Error(
      `Cron schedule "${expr}" must have five fields: minute hour day month weekday.`,
    );
  }
  try {
    void new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new Error(`Unknown time zone "${timeZone}".`);
  }
  // SAFETY: parts has exactly five entries (checked above), so the map yields five Fields.
  const [minute, hour, dom, month, dow] = parts.map((p, i) => field(p, BOUNDS[i]!)) as [
    Field,
    Field,
    Field,
    Field,
    Field,
  ];
  if (dow.values.has(7)) {
    dow.values.add(0);
  }
  return { expr: parts.join(" "), timeZone, minute, hour, dom, month, dow };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function wall(ms: number, timeZone: string): Wall {
  let format = formatters.get(timeZone);
  if (!format) {
    formatters.set(
      timeZone,
      (format = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        weekday: "short",
      })),
    );
  }
  const parts = Object.fromEntries(format.formatToParts(ms).map((p) => [p.type, p.value]));
  const w = {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: WEEKDAYS[parts.weekday!]!,
  };
  return { ...w, key: `${parts.year}-${w.month}-${w.day} ${w.hour}:${w.minute}` };
}

function dayMatches(cron: Cron, w: Wall) {
  if (!cron.month.values.has(w.month)) {
    return false;
  }
  const dom = cron.dom.values.has(w.day),
    dow = cron.dow.values.has(w.weekday);
  return cron.dom.any || cron.dow.any ? dom && dow : dom || dow;
}

/**
 * First matching minute strictly after `afterMs`, as UTC ms. A wall-clock
 * minute repeated by a daylight-saving fall-back fires once (its first
 * occurrence); a skipped one does not fire.
 */
export function nextRun(cron: Cron, afterMs: number): number {
  let t = Math.floor(afterMs / MINUTE) * MINUTE + MINUTE;
  const seen = wall(afterMs, cron.timeZone).key;
  for (let i = 0; i < 600_000; i++) {
    const w = wall(t, cron.timeZone);
    // Skip whole wall days or hours that cannot match.
    if (!dayMatches(cron, w)) {
      t += ((23 - w.hour) * 60 + (60 - w.minute)) * MINUTE;
      continue;
    }
    if (!cron.hour.values.has(w.hour)) {
      t += (60 - w.minute) * MINUTE;
      continue;
    }
    if (
      cron.minute.values.has(w.minute) &&
      w.key !== seen &&
      wall(t - 3_600_000, cron.timeZone).key !== w.key
    ) {
      return t;
    }
    t += MINUTE;
  }
  throw new Error(`Cron schedule "${cron.expr}" has no run within a year.`);
}
