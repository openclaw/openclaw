import { asDateTimestampMs } from "openclaw/plugin-sdk/string-coerce-runtime";
import { workboardLocale } from "../host.ts";
import { t } from "../i18n/index.ts";
type DurationUnit = "millisecond" | "second" | "minute" | "hour" | "day";

function formatUnit(value: number, unit: DurationUnit): string {
  return new Intl.NumberFormat(workboardLocale(), {
    style: "unit",
    unit,
    unitDisplay: "narrow",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatUnitPair(
  value: number,
  unit: DurationUnit,
  remainder: number,
  remainderUnit: DurationUnit,
): string {
  const parts = [formatUnit(value, unit)];
  if (remainder > 0) {
    parts.push(formatUnit(remainder, remainderUnit));
  }
  return parts.join(" ");
}

export function formatDurationCompact(ms?: number | null): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) {
    return undefined;
  }
  const roundedMs = Math.round(ms);
  if (roundedMs < 1000) {
    return formatUnit(roundedMs, "millisecond");
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return formatUnit(totalSeconds, "second");
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return formatUnitPair(totalMinutes, "minute", totalSeconds % 60, "second");
  }
  const hours = Math.floor(totalMinutes / 60);
  return hours >= 24
    ? formatUnitPair(Math.floor(hours / 24), "day", hours % 24, "hour")
    : formatUnitPair(hours, "hour", totalMinutes % 60, "minute");
}

export function formatDateTimeMs(
  ms?: number | null,
  options?: Intl.DateTimeFormatOptions,
  fallback = t("common.na"),
): string {
  const timestampMs = asDateTimestampMs(ms);
  return timestampMs === undefined
    ? fallback
    : new Date(timestampMs).toLocaleString(workboardLocale(), options);
}
