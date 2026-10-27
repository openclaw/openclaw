import type { LoadedRecord } from "./model.js";
import { validSourceDate } from "./temporal.js";

export type TimeField = "occurred_at" | "recorded_at" | "updated_at" | "due_at";
export type TimeFilter = { timeField?: TimeField; since?: string; until?: string };
const dayMs = 86_400_000;

/** Accept storage timestamp fractions without relaxing authored occurrence-date validation. */
export function validTemporalDate(value: string): boolean {
  return validSourceDate(value.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:\d{2}$)/, "$1"));
}

/** Compare identical precision: calendar dates or equivalent timezone-bearing instants. */
export function sameTemporalDate(a: string | undefined, b: string | undefined): boolean {
  return (
    Boolean(a) &&
    Boolean(b) &&
    (a!.length === 10) === (b!.length === 10) &&
    dateInterval(a!).start === dateInterval(b!).start
  );
}

/** Query-only interval: date-only values retain their original precision. */
export function dateInterval(value: string): { start: number; end: number } {
  if (!validTemporalDate(value)) {
    throw new Error(
      "Expected a real YYYY-MM-DD date or ISO timestamp with an explicit timezone: " + value,
    );
  }
  const start = Date.parse(value);
  return { start, end: start + (value.length === 10 ? dayMs - 1 : 0) };
}

/** Inclusive range; a date-only upper bound includes that entire UTC calendar day. */
export function timeBounds(input: TimeFilter) {
  const start = input.since === undefined ? null : dateInterval(input.since).start;
  const end = input.until === undefined ? null : dateInterval(input.until).end;
  if (start !== null && end !== null && start > end) {
    throw new Error("since must not be after until.");
  }
  return { start, end };
}

/** Read an authored date, never substituting ingestion time for unknown occurrence. */
export function recordDate(record: LoadedRecord, field: TimeField): string | undefined {
  const value =
    record.metadata[field] ??
    (field === "occurred_at" ? record.metadata.fields?.occurred_at : undefined);
  return typeof value === "string" &&
    (field === "recorded_at" || field === "updated_at"
      ? validTemporalDate(value)
      : validSourceDate(value))
    ? value
    : undefined;
}

/** Apply the same precision-aware interval semantics to search and inventory. */
export function temporalPredicate(input: TimeFilter): (record: LoadedRecord) => boolean {
  const { start, end } = timeBounds(input);
  if (start === null && end === null) {
    return () => true;
  }
  return (record) => {
    const value = recordDate(record, input.timeField ?? "occurred_at");
    if (!value) {
      return false;
    }
    const interval = dateInterval(value);
    return (start === null || interval.end >= start) && (end === null || interval.start <= end);
  };
}

/** Source dates remain calendar dates; timestamp days use the requested IANA zone. */
export function calendarDay(value: string, timezone = "UTC"): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  if (value.length === 10) {
    return value;
  }
  const parts = formatter.formatToParts(new Date(value));
  return ["year", "month", "day"].map((key) => parts.find((p) => p.type === key)!.value).join("-");
}

/** Calendar arithmetic independent of the machine's timezone and DST. */
export function shiftDay(day: string, days: number): string {
  return new Date(dateInterval(day).start + days * dayMs).toISOString().slice(0, 10);
}
