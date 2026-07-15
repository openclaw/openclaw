// Normalization Core tests cover number coercion behavior.
import { describe, expect, test } from "vitest";
import {
  asDateTimestampMs,
  asFiniteNumber,
  asFiniteNumberInRange,
  asSafeIntegerInRange,
  asPositiveSafeInteger,
  addTimerTimeoutGraceMs,
  clampPositiveTimerTimeoutMs,
  clampTimerTimeoutMs,
  finiteSecondsToTimerSafeMilliseconds,
  isFutureDateTimestampMs,
  MAX_TIMER_TIMEOUT_MS,
  MAX_TIMER_TIMEOUT_SECONDS,
  nonNegativeSecondsToSafeMilliseconds,
  parseFiniteNumber,
  positiveSecondsToSafeMilliseconds,
  resolveIntegerOption,
  resolveExpiresAtMsFromDurationMs,
  resolveExpiresAtMsFromDurationSeconds,
  resolveExpiresAtMsFromDurationOrEpoch,
  resolveExpiresAtMsFromEpochSeconds,
  resolveNonNegativeIntegerOption,
  resolveOptionalIntegerOption,
  resolvePositiveTimerTimeoutMs,
  resolveDateTimestampMs,
  parseStrictFiniteNumber,
  parseStrictInteger,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
  resolveTimerTimeoutMs,
  resolveTimestampMsToIsoString,
  timestampMsToIsoFileStamp,
  timestampMsToIsoString,
  MAX_DATE_TIMESTAMP_MS,
} from "./number-coercion.js";

describe("number-coercion", () => {
  test("asFiniteNumber accepts only finite numbers", () => {
    expect(asFiniteNumber(4)).toBe(4);
    expect(asFiniteNumber(Number.NaN)).toBeUndefined();
    expect(asFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(asFiniteNumber("abc")).toBeUndefined();
  });

  test("asFiniteNumberInRange enforces inclusive/exclusive bounds", () => {
    expect(asFiniteNumberInRange(5, { min: 1, max: 10 })).toBe(5);
    expect(asFiniteNumberInRange(5, { min: 5 })).toBe(5);
    expect(asFiniteNumberInRange(5, { max: 5 })).toBe(5);
    expect(asFiniteNumberInRange(5, { min: 5, minExclusive: true })).toBeUndefined();
    expect(asFiniteNumberInRange(5, { max: 5, maxExclusive: true })).toBeUndefined();
    expect(asFiniteNumberInRange(Number.NaN, { min: 1 })).toBeUndefined();
    expect(asFiniteNumberInRange(15, { min: 5, max: 10 })).toBeUndefined();
    expect(asFiniteNumberInRange(5, { min: 10, max: 5 })).toBe(5);
  });

  test("asSafeIntegerInRange accepts only safe integers", () => {
    expect(asSafeIntegerInRange(5, { min: 1, max: 10 })).toBe(5);
    expect(asSafeIntegerInRange(Number.MAX_SAFE_INTEGER, {})).toBe(Number.MAX_SAFE_INTEGER);
    expect(asSafeIntegerInRange(Number.MIN_SAFE_INTEGER, {})).toBe(Number.MIN_SAFE_INTEGER);
    expect(asSafeIntegerInRange(Number.MAX_SAFE_INTEGER + 1, {})).toBeUndefined();
    expect(asSafeIntegerInRange(Number.MIN_SAFE_INTEGER - 1, {})).toBeUndefined();
    expect(asSafeIntegerInRange(Number.NaN, {})).toBeUndefined();
    expect(asSafeIntegerInRange(Infinity, {})).toBeUndefined();
    expect(asSafeIntegerInRange(3.14, {})).toBeUndefined();
    expect(asSafeIntegerInRange("5", {})).toBeUndefined();
  });

  test("parseFiniteNumber handles numbers and strict numeric strings", () => {
    expect(parseFiniteNumber(4)).toBe(4);
    expect(parseFiniteNumber(4.5)).toBe(4.5);
    expect(parseFiniteNumber(Number.NaN)).toBeUndefined();
    expect(parseFiniteNumber(Infinity)).toBeUndefined();
    expect(parseFiniteNumber("4")).toBe(4);
    expect(parseFiniteNumber("4.5")).toBe(4.5);
    expect(parseFiniteNumber("  4  ")).toBe(4);
    expect(parseFiniteNumber("abc")).toBeUndefined();
    expect(parseFiniteNumber("1e309")).toBeUndefined();
  });

  test("parseStrictFiniteNumber handles finite numeric strings", () => {
    expect(parseStrictFiniteNumber(4)).toBe(4);
    expect(parseStrictFiniteNumber(4.5)).toBe(4.5);
    expect(parseStrictFiniteNumber(Infinity)).toBeUndefined();
    expect(parseStrictFiniteNumber(Number.NaN)).toBeUndefined();
    expect(parseStrictFiniteNumber("4")).toBe(4);
    expect(parseStrictFiniteNumber("4.5")).toBe(4.5);
    expect(parseStrictFiniteNumber(".5")).toBe(0.5);
    expect(parseStrictFiniteNumber("1e10")).toBe(10000000000);
    expect(parseStrictFiniteNumber("   1e10   ")).toBe(10000000000);
    expect(parseStrictFiniteNumber("1e308")).toBe(1e308);
    expect(parseStrictFiniteNumber("1e309")).toBeUndefined();
    expect(parseStrictFiniteNumber("abc")).toBeUndefined();
    expect(parseStrictFiniteNumber("1.2.3")).toBeUndefined();
    // Large exponent strings with 4+ digits are rejected early by the regex
    expect(parseStrictFiniteNumber("1e9999")).toBeUndefined();
    expect(parseStrictFiniteNumber("1e99999")).toBeUndefined();
    expect(parseStrictFiniteNumber("1e100000")).toBeUndefined();
  });

  test("parseStrictInteger parses only base-10 integer strings", () => {
    expect(parseStrictInteger(4)).toBe(4);
    expect(parseStrictInteger(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseStrictInteger(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
    expect(parseStrictInteger(4.5)).toBeUndefined();
    expect(parseStrictInteger("4")).toBe(4);
    expect(parseStrictInteger("  4  ")).toBe(4);
    expect(parseStrictInteger("9007199254740991")).toBe(9007199254740991);
    expect(parseStrictInteger("9007199254740992")).toBeUndefined();
    expect(parseStrictInteger("abc")).toBeUndefined();
    expect(parseStrictInteger("4.5")).toBeUndefined();
    expect(parseStrictInteger("0x10")).toBeUndefined();
  });

  test("positive and non-negative integer parsers enforce sign constraints", () => {
    expect(parseStrictPositiveInteger("5")).toBe(5);
    expect(parseStrictPositiveInteger("0")).toBeUndefined();
    expect(parseStrictPositiveInteger(0)).toBeUndefined();
    expect(parseStrictPositiveInteger("-1")).toBeUndefined();
    expect(parseStrictNonNegativeInteger("0")).toBe(0);
    expect(parseStrictNonNegativeInteger("5")).toBe(5);
    expect(parseStrictNonNegativeInteger("-1")).toBeUndefined();
  });

  test("asPositiveSafeInteger returns only positive safe integers", () => {
    expect(asPositiveSafeInteger(5)).toBe(5);
    expect(asPositiveSafeInteger(0)).toBeUndefined();
    expect(asPositiveSafeInteger(-1)).toBeUndefined();
    expect(asPositiveSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(asPositiveSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
    expect(asPositiveSafeInteger(Number.NaN)).toBeUndefined();
    expect(asPositiveSafeInteger(Infinity)).toBeUndefined();
  });

  test("clampTimerTimeoutMs clamps within Node-safe timer range", () => {
    expect(clampTimerTimeoutMs(1000)).toBe(1000);
    expect(clampTimerTimeoutMs(0)).toBe(1);
    expect(clampTimerTimeoutMs(-100)).toBe(1);
    expect(clampTimerTimeoutMs(MAX_TIMER_TIMEOUT_MS + 1)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(clampTimerTimeoutMs(Number.NaN)).toBeUndefined();
    expect(clampTimerTimeoutMs(Infinity)).toBeUndefined();
  });

  test("clampPositiveTimerTimeoutMs rejects non-positive values", () => {
    expect(clampPositiveTimerTimeoutMs(1000)).toBe(1000);
    expect(clampPositiveTimerTimeoutMs(0)).toBeUndefined();
    expect(clampPositiveTimerTimeoutMs(-1)).toBeUndefined();
    expect(clampPositiveTimerTimeoutMs(Number.NaN)).toBeUndefined();
  });

  test("finiteSecondsToTimerSafeMilliseconds converts seconds to ms safely", () => {
    expect(finiteSecondsToTimerSafeMilliseconds(5)).toBe(5000);
    expect(finiteSecondsToTimerSafeMilliseconds(0)).toBeUndefined();
    expect(finiteSecondsToTimerSafeMilliseconds(Infinity)).toBeUndefined();
    expect(finiteSecondsToTimerSafeMilliseconds(Number.NaN)).toBeUndefined();
  });

  test("resolveTimerTimeoutMs resolves with fallback and minimum bounds", () => {
    expect(resolveTimerTimeoutMs(1000, 5000)).toBe(1000);
    expect(resolveTimerTimeoutMs(0, 5000)).toBe(1);
    expect(resolveTimerTimeoutMs(Number.NaN, 5000)).toBe(5000);
    expect(resolveTimerTimeoutMs(Infinity, 5000)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveTimerTimeoutMs(MAX_TIMER_TIMEOUT_MS * 2, 5000)).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  test("addTimerTimeoutGraceMs adds grace and clamps", () => {
    expect(addTimerTimeoutGraceMs(1000, 500)).toBe(1500);
    expect(addTimerTimeoutGraceMs(Number.NaN, 500)).toBeUndefined();
  });

  test("date timestamp helpers validate Date range", () => {
    expect(asDateTimestampMs(1_000)).toBe(1_000);
    expect(asDateTimestampMs(0)).toBe(0);
    expect(asDateTimestampMs(-MAX_DATE_TIMESTAMP_MS)).toBe(-MAX_DATE_TIMESTAMP_MS);
    expect(asDateTimestampMs(MAX_DATE_TIMESTAMP_MS)).toBe(MAX_DATE_TIMESTAMP_MS);
    expect(asDateTimestampMs(MAX_DATE_TIMESTAMP_MS + 1)).toBeUndefined();
    expect(asDateTimestampMs(-MAX_DATE_TIMESTAMP_MS - 1)).toBeUndefined();
    expect(asDateTimestampMs(Number.NaN)).toBeUndefined();
    expect(asDateTimestampMs(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  test("timestampMsToIsoString converts valid timestamps", () => {
    expect(timestampMsToIsoString(1_000)).toBe("1970-01-01T00:00:01.000Z");
    expect(timestampMsToIsoString(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(timestampMsToIsoString(8_640_000_000_000_001)).toBeUndefined();
    expect(timestampMsToIsoString(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(timestampMsToIsoString("0")).toBeUndefined();
  });

  test("future timestamp helper rejects invalid Date timestamps", () => {
    expect(isFutureDateTimestampMs(1_001, { nowMs: 1_000 })).toBe(true);
    expect(isFutureDateTimestampMs(1_000, { nowMs: 1_000 })).toBe(false);
    expect(isFutureDateTimestampMs(999, { nowMs: 1_000 })).toBe(false);
    expect(isFutureDateTimestampMs(8_640_000_000_000_001, { nowMs: 1_000 })).toBe(false);
    expect(isFutureDateTimestampMs(1_001, { nowMs: Number.NaN })).toBe(false);
  });

  test("timestamp fallback helpers resolve Date-invalid timestamps", () => {
    expect(resolveDateTimestampMs(1_000)).toBe(1_000);
    expect(resolveDateTimestampMs(Number.POSITIVE_INFINITY, 1_000)).toBe(1_000);
    expect(resolveDateTimestampMs(Number.POSITIVE_INFINITY, Number.NaN)).toBe(0);
    expect(resolveTimestampMsToIsoString(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(resolveTimestampMsToIsoString(Number.POSITIVE_INFINITY, 1_000)).toBe(
      "1970-01-01T00:00:01.000Z",
    );
    expect(resolveTimestampMsToIsoString(Number.POSITIVE_INFINITY, Number.NaN)).toBe(
      "1970-01-01T00:00:00.000Z",
    );
    expect(timestampMsToIsoFileStamp(Date.parse("2026-02-23T12:34:56.000Z"))).toBe(
      "2026-02-23T12-34-56.000Z",
    );
    expect(timestampMsToIsoFileStamp(9_000_000_000_000_000, 1_000)).toBe(
      "1970-01-01T00-00-01.000Z",
    );
  });

  test("expiry helpers resolve safe absolute timestamps", () => {
    expect(
      resolveExpiresAtMsFromDurationMs(600_000, {
        nowMs: 1_000,
      }),
    ).toBe(601_000);
    expect(
      resolveExpiresAtMsFromDurationMs(600_000, {
        nowMs: 8_640_000_000_000_000,
      }),
    ).toBeUndefined();
    expect(
      resolveExpiresAtMsFromDurationMs(600_000, {
        nowMs: 8_640_000_000_000_001,
      }),
    ).toBeUndefined();
    expect(
      resolveExpiresAtMsFromDurationSeconds("3600", {
        nowMs: 1_000,
        bufferMs: 300,
      }),
    ).toBe(3_600_700);
    expect(
      resolveExpiresAtMsFromDurationSeconds("10", {
        nowMs: 1_000,
        bufferMs: 20_000,
        minRemainingMs: 30_000,
      }),
    ).toBe(31_000);
    expect(
      resolveExpiresAtMsFromDurationSeconds("3600", {
        nowMs: 8_640_000_000_000_000,
      }),
    ).toBeUndefined();
    expect(resolveExpiresAtMsFromDurationSeconds("1e309", { nowMs: 1_000 })).toBeUndefined();
    expect(resolveExpiresAtMsFromEpochSeconds(1234.9)).toBe(1_234_000);
    expect(resolveExpiresAtMsFromEpochSeconds("3600", { bufferMs: 300 })).toBe(3_599_700);
    expect(resolveExpiresAtMsFromEpochSeconds("100", { maxMs: 99_999 })).toBeUndefined();
    expect(resolveExpiresAtMsFromEpochSeconds(Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(resolveExpiresAtMsFromEpochSeconds(8_640_000_000_001)).toBeUndefined();
    expect(resolveExpiresAtMsFromEpochSeconds("1e309")).toBeUndefined();
  });

  test("mixed expiry helper handles relative seconds, epoch seconds, and absolute milliseconds", () => {
    expect(resolveExpiresAtMsFromDurationOrEpoch(86_400, { nowMs: 1_700_000_000_000 })).toBe(
      1_700_086_400_000,
    );
    expect(resolveExpiresAtMsFromDurationOrEpoch(1_700_000_000)).toBe(1_700_000_000_000);
    expect(resolveExpiresAtMsFromDurationOrEpoch(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(resolveExpiresAtMsFromDurationOrEpoch(8_640_000_000_000_001)).toBeUndefined();
    expect(resolveExpiresAtMsFromDurationOrEpoch(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(resolveExpiresAtMsFromDurationOrEpoch(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
  });

  test("integer option helpers floor finite values and fall back for non-finite values", () => {
    expect(resolveIntegerOption(7.9, 1, { min: 1, max: 10 })).toBe(7);
    expect(resolveIntegerOption(Number.NaN, 4.9, { min: 1 })).toBe(4);
    expect(resolveIntegerOption(Number.NEGATIVE_INFINITY, 4, { min: 1 })).toBe(4);
    expect(resolveIntegerOption(-4, 1, { min: 0 })).toBe(0);
    expect(resolveIntegerOption(40, 1, { max: 10 })).toBe(10);
    expect(resolveNonNegativeIntegerOption(Number.NaN, 3.9)).toBe(3);
  });

  test("optional integer option helper rejects non-finite values", () => {
    expect(resolveOptionalIntegerOption(7.9, { min: 1, max: 10 })).toBe(7);
    expect(resolveOptionalIntegerOption(Number.NaN, { min: 1 })).toBeUndefined();
    expect(resolveOptionalIntegerOption(Number.POSITIVE_INFINITY, { min: 1 })).toBeUndefined();
    expect(resolveOptionalIntegerOption(-4, { min: 0 })).toBe(0);
    expect(resolveOptionalIntegerOption(40, { max: 10 })).toBe(10);
  });

  test("resolvePositiveTimerTimeoutMs resolves or falls back", () => {
    expect(resolvePositiveTimerTimeoutMs(1000, 5000)).toBe(1000);
    expect(resolvePositiveTimerTimeoutMs(0, 5000)).toBe(5000);
    expect(resolvePositiveTimerTimeoutMs(Number.NaN, 5000)).toBe(5000);
  });

  test("finiteSecondsToTimerSafeMilliseconds handles boundary cases", () => {
    expect(finiteSecondsToTimerSafeMilliseconds(1)).toBe(1000);
    expect(finiteSecondsToTimerSafeMilliseconds(1.5)).toBe(1500);
    expect(finiteSecondsToTimerSafeMilliseconds(MAX_TIMER_TIMEOUT_SECONDS)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(finiteSecondsToTimerSafeMilliseconds("abc")).toBeUndefined();
    expect(finiteSecondsToTimerSafeMilliseconds(0, { floorSeconds: true })).toBeUndefined();
  });
});
