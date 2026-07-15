import {
  optionalPositiveIntegerSchema,
  readPositiveIntegerParam,
} from "openclaw/plugin-sdk/channel-actions";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";

/** Default late/early grace window for attendance annotations. */
const GOOGLE_MEET_ATTENDANCE_GRACE_DEFAULT_MINUTES = 5;

/**
 * Max minutes where minutes * 60_000 stays within Number.MAX_SAFE_INTEGER.
 * Rejects overflow-class inputs without inventing a one-day product policy.
 */
const GOOGLE_MEET_ATTENDANCE_GRACE_MAX_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);

/**
 * Resolves attendance grace minutes to a finite positive integer. Non-finite or
 * overflow-class values fall back so late/early checks stay meaningful.
 */
export function resolveAttendanceGraceMinutes(
  raw: unknown,
  fallback = GOOGLE_MEET_ATTENDANCE_GRACE_DEFAULT_MINUTES,
): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  const floored = Math.floor(raw);
  if (floored < 1 || floored > GOOGLE_MEET_ATTENDANCE_GRACE_MAX_MINUTES) {
    return fallback;
  }
  return floored;
}

/** CLI parser: reject floats, zero, and numeric-overflow grace windows. */
function parseAttendanceGraceMinutesOption(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined || parsed > GOOGLE_MEET_ATTENDANCE_GRACE_MAX_MINUTES) {
    throw new Error(
      `${label} must be a positive integer between 1 and ${GOOGLE_MEET_ATTENDANCE_GRACE_MAX_MINUTES}`,
    );
  }
  return parsed;
}

export function parseLateAfterMinutesOption(value: string | undefined): number | undefined {
  return parseAttendanceGraceMinutesOption(value, "late-after-minutes");
}

export function parseEarlyBeforeMinutesOption(value: string | undefined): number | undefined {
  return parseAttendanceGraceMinutesOption(value, "early-before-minutes");
}

/** Tool schema for late/early grace minutes (matches CLI/runtime max). */
export function optionalAttendanceGraceMinutesSchema(description: string) {
  return optionalPositiveIntegerSchema({
    description,
    maximum: GOOGLE_MEET_ATTENDANCE_GRACE_MAX_MINUTES,
  });
}

/** Tool param reader for late/early grace minutes. */
export function readAttendanceGraceParam(
  raw: Record<string, unknown>,
  key: string,
): number | undefined {
  return readPositiveIntegerParam(raw, key, {
    max: GOOGLE_MEET_ATTENDANCE_GRACE_MAX_MINUTES,
    message: `${key} must be a positive integer between 1 and ${GOOGLE_MEET_ATTENDANCE_GRACE_MAX_MINUTES}`,
  });
}
