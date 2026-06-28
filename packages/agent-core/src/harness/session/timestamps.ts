const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
const STRICT_TIMESTAMP_STRING_RE =
  /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function hasValidTimestampFields(parts: RegExpMatchArray): boolean {
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const zone = parts[7];
  const zoneHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59 &&
    zoneHour >= 0 &&
    zoneHour <= 23 &&
    zoneMinute >= 0 &&
    zoneMinute <= 59
  );
}

/** Parse an ISO-like session timestamp to milliseconds. */
export function parseSessionTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  const match = normalized.match(STRICT_TIMESTAMP_STRING_RE);
  if (!match || !hasValidTimestampFields(match)) {
    return undefined;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) && Math.abs(parsed) <= MAX_DATE_TIMESTAMP_MS ? parsed : undefined;
}

/** Parse a required timestamp or throw a labeled validation error. */
export function requireSessionTimestampMs(value: string, label: string): number {
  const parsed = parseSessionTimestampMs(value);
  if (parsed === undefined) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return parsed;
}
