import { durationUnitMs } from "../../src/infra/format-time/duration-units.ts";
import { resolveExactDurationParts } from "../../src/infra/format-time/format-duration-exact.ts";
import {
  formatDurationParts,
  type DurationPart,
} from "../../src/infra/format-time/format-duration-internal.ts";

/** Formats non-negative, pre-rounded script timings with fractional seconds. */
export function formatDurationElapsed(
  ms: number,
  options: { secondsDecimalDigits?: 1 | 2; unitCount?: 1 | 2; showYears?: boolean } = {},
): string {
  const exact = resolveExactDurationParts(ms);
  if (!exact) {
    throw new TypeError("Expected a non-negative finite number");
  }
  if (ms < durationUnitMs.second) {
    return `${ms}ms`;
  }
  const daysPerYear = BigInt(durationUnitMs.year / durationUnitMs.day);
  const wholeParts = exact.flatMap(({ value, unit }): DurationPart[] => {
    if (unit === "second" || unit === "millisecond") {
      return [];
    }
    if (unit !== "day" || options.showYears === false) {
      return [{ value, unit }];
    }
    const days = BigInt(value);
    const dayParts: DurationPart[] = [
      { value: days / daysPerYear, unit: "year" },
      { value: days % daysPerYear, unit: "day" },
    ];
    return dayParts.filter((part) => part.value !== 0n);
  });
  const decimals = options.secondsDecimalDigits ?? 1;
  const scale = 10 ** decimals;
  // Avoid dropping a displayed decimal when binary division lands just below it.
  const seconds = Math.floor(((ms / durationUnitMs.second) % 60) * scale + 0.000_000_1) / scale;
  const unitCount = options.unitCount ?? Infinity;
  const units = wholeParts.slice(0, unitCount);
  const result = [formatDurationParts(units)];
  if (seconds > 0 && units.length < unitCount) {
    result.push(`${seconds.toFixed(decimals).replace(/\.0+$/, "")}s`);
  }
  return result.filter(Boolean).join(" ") || "0ms";
}
