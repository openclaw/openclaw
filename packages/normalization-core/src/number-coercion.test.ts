import { describe, expect, test } from "vitest";
import * as num from "./number-coercion.js";

describe("number-coercion", () => {
  const nowMs = 1_000;
  const dateLimit = 8_640_000_000_000_000;
  const timerLimit = num.MAX_TIMER_TIMEOUT_MS;
  const epoch = "1970-01-01T00:00:00.000Z";
  const epochSecond = "1970-01-01T00:00:01.000Z";
  test.each([
    ["positive integer", 1, 1, 1, 1],
    ["unsafe integer", 2 ** 53, 2 ** 53, 2 ** 53, 2 ** 53],
    ["zero", 0, undefined, 0, undefined],
    ["negative zero", -0, undefined, -0, undefined],
    ["negative integer", -1, undefined, undefined, undefined],
    ["positive fraction", 1.5, undefined, undefined, 1],
    ["fraction below one", 0.5, undefined, undefined, 0],
    ["NaN", Number.NaN, undefined, undefined, undefined],
    ["infinity", Number.POSITIVE_INFINITY, undefined, undefined, undefined],
    ["numeric string", "1", undefined, undefined, undefined],
    ["missing input", undefined, undefined, undefined, undefined],
  ])("integer policies for %s", (_name, input, positive, nonNegative, floored) => {
    expect(num.asPositiveInteger(input)).toBe(positive);
    expect(num.asNonNegativeInteger(input)).toBe(nonNegative);
    expect(num.floorPositiveFiniteNumber(input)).toBe(floored);
  });

  test("signed finite helpers preserve finite fractional values", () => {
    expect(num.asPositiveFiniteNumber(0.5)).toBe(0.5);
    expect(num.asPositiveFiniteNumber(0)).toBeUndefined();
    expect(num.asPositiveFiniteNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(num.asNonNegativeFiniteNumber(0)).toBe(0);
    expect(num.asNonNegativeFiniteNumber(-0.5)).toBeUndefined();
    expect(num.asNonNegativeFiniteNumber("1")).toBeUndefined();
  });

  test("asFiniteNumberInRange enforces inclusive and exclusive bounds", () => {
    expect(num.asFiniteNumberInRange(0.5, { min: 0.5, max: 2 })).toBe(0.5);
    expect(num.asFiniteNumberInRange(2, { min: 0.5, max: 2 })).toBe(2);
    expect(num.asFiniteNumberInRange(0.5, { min: 0.5, minExclusive: true })).toBeUndefined();
    expect(num.asFiniteNumberInRange(10, { max: 10, maxExclusive: true })).toBeUndefined();
    expect(num.asFiniteNumberInRange("1", { min: 0, max: 2 })).toBeUndefined();
  });

  test("asSafeIntegerInRange accepts only safe integers inside inclusive bounds", () => {
    expect(num.asSafeIntegerInRange(-1, { min: -1, max: 10 })).toBe(-1);
    expect(num.asSafeIntegerInRange(10, { min: -1, max: 10 })).toBe(10);
    expect(num.asSafeIntegerInRange(1.5, { min: -1, max: 10 })).toBeUndefined();
    expect(num.asSafeIntegerInRange(11, { min: -1, max: 10 })).toBeUndefined();
    expect(num.asSafeIntegerInRange(Number.NaN, { min: -1, max: 10 })).toBeUndefined();
  });

  test("parseFiniteNumber accepts finite numbers and numeric strings", () => {
    expect(num.parseFiniteNumber(4)).toBe(4);
    expect(num.parseFiniteNumber("4.5")).toBe(4.5);
    expect(num.parseFiniteNumber("4.5ms")).toBeUndefined();
    expect(num.parseFiniteNumber("")).toBeUndefined();
    expect(num.parseFiniteNumber("nope")).toBeUndefined();
  });

  test.each([
    ["Unicode-trimmed signed zero", "\u00a0-0\u2003", -0, -0],
    ["unsafe integer", "9007199254740992", undefined, 9_007_199_254_740_992],
    ["scientific overflow", "1e309", undefined, undefined],
    ["scientific underflow", "-1e-400", undefined, -0],
    ["coercible array", ["4"], undefined, undefined],
    ["coercible object", { valueOf: (): number => 4 }, undefined, undefined],
  ])("preserves strict parser boundaries for %s", (_name, value, integer, finite) => {
    expect(num.parseStrictInteger(value)).toBe(integer);
    expect(num.parseStrictFiniteNumber(value)).toBe(finite);
  });

  test("timer timeout helpers centralize Node-safe bounds", () => {
    expect(num.MAX_TIMER_TIMEOUT_SECONDS).toBe(2_147_000);
    expect(num.finiteSecondsToTimerSafeMilliseconds(1.5)).toBe(1_500);
    expect(num.finiteSecondsToTimerSafeMilliseconds(1.5, { floorSeconds: true })).toBe(1_000);
    expect(num.finiteSecondsToTimerSafeMilliseconds(10_000_000)).toBe(timerLimit);
    expect(num.finiteSecondsToTimerSafeMilliseconds(Number.MAX_VALUE)).toBe(timerLimit);
    expect(num.finiteSecondsToTimerSafeMilliseconds("10")).toBeUndefined();
    expect(num.finiteSecondsToTimerSafeMilliseconds(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(num.clampTimerTimeoutMs(0, 10)).toBe(10);
    expect(num.clampTimerTimeoutMs(10_000_000_000)).toBe(timerLimit);
    expect(num.clampTimerTimeoutMs(Number.NaN)).toBeUndefined();
    expect(num.clampPositiveTimerTimeoutMs(0)).toBeUndefined();
    expect(num.clampPositiveTimerTimeoutMs(-1)).toBeUndefined();
    expect(num.clampPositiveTimerTimeoutMs(10_000_000_000)).toBe(timerLimit);
    expect(num.resolvePositiveTimerTimeoutMs(0, 5000)).toBe(5000);
    expect(num.resolvePositiveTimerTimeoutMs(Number.MAX_SAFE_INTEGER, 5000)).toBe(timerLimit);
    expect(num.resolveTimerTimeoutMs(Number.NaN, 5000)).toBe(5000);
    expect(num.resolveTimerTimeoutMs(Number.NaN, 0, 0)).toBe(0);
    expect(num.resolveTimerTimeoutMs(Number.NaN, Number.POSITIVE_INFINITY, 25)).toBe(25);
    expect(num.resolveTimerTimeoutMs(Number.MAX_SAFE_INTEGER, 5000)).toBe(timerLimit);
    expect(num.addTimerTimeoutGraceMs(10_000)).toBe(15_000);
    expect(num.addTimerTimeoutGraceMs(10_000, 500)).toBe(10_500);
    expect(num.addTimerTimeoutGraceMs(timerLimit - 100, 500)).toBe(timerLimit);
    expect(num.addTimerTimeoutGraceMs(Number.MAX_SAFE_INTEGER)).toBe(timerLimit);
    expect(num.addTimerTimeoutGraceMs(Number.MAX_VALUE)).toBe(timerLimit);
    expect(num.addTimerTimeoutGraceMs(Number.NaN)).toBeUndefined();
  });

  test("seconds helpers reject unsafe millisecond values", () => {
    expect(num.positiveSecondsToSafeMilliseconds("10")).toBe(10_000);
    expect(num.positiveSecondsToSafeMilliseconds("0")).toBeUndefined();
    expect(num.positiveSecondsToSafeMilliseconds("1e309")).toBeUndefined();
    expect(num.nonNegativeSecondsToSafeMilliseconds("0")).toBe(0);
    expect(num.nonNegativeSecondsToSafeMilliseconds("-1")).toBeUndefined();
  });

  test.each([
    { value: 0, expected: 0 },
    { value: "0", expected: Date.parse("0") },
    { value: Number.POSITIVE_INFINITY, expected: undefined },
    { value: num.MAX_DATE_TIMESTAMP_MS + 1, expected: num.MAX_DATE_TIMESTAMP_MS + 1 },
    { value: true, expected: undefined },
  ])("parseDateFirstTimestampMs parses $value", ({ value, expected }) => {
    expect(num.parseDateFirstTimestampMs(value)).toBe(expected);
  });

  test("future timestamp helper rejects invalid Date timestamps", () => {
    expect(num.isFutureDateTimestampMs(1_001, { nowMs })).toBe(true);
    expect(num.isFutureDateTimestampMs(1_000, { nowMs })).toBe(false);
    expect(num.isFutureDateTimestampMs(dateLimit + 1, { nowMs })).toBe(false);
    expect(num.isFutureDateTimestampMs(1_001, { nowMs: Number.NaN })).toBe(false);
  });

  test("timestamp fallback helpers resolve Date-invalid timestamps", () => {
    expect(num.resolveDateTimestampMs(1_000)).toBe(1_000);
    expect(num.resolveDateTimestampMs(Number.POSITIVE_INFINITY, 1_000)).toBe(1_000);
    expect(num.resolveDateTimestampMs(Number.POSITIVE_INFINITY, Number.NaN)).toBe(0);
    expect(num.resolveTimestampMsToIsoString(0)).toBe(epoch);
    expect(num.resolveTimestampMsToIsoString(Number.POSITIVE_INFINITY, 1_000)).toBe(epochSecond);
    expect(num.resolveTimestampMsToIsoString(Number.POSITIVE_INFINITY, Number.NaN)).toBe(epoch);
    expect(num.timestampMsToIsoFileStamp(Date.parse("2026-02-23T12:34:56.000Z"))).toBe(
      "2026-02-23T12-34-56.000Z",
    );
    expect(num.timestampMsToIsoFileStamp(9_000_000_000_000_000, 1_000)).toBe(
      "1970-01-01T00-00-01.000Z",
    );
  });

  test("expiry helpers resolve safe absolute timestamps", () => {
    expect(num.resolveExpiresAtMsFromDurationMs(600_000, { nowMs })).toBe(601_000);
    expect(num.resolveExpiresAtMsFromDurationMs(600_000, { nowMs: dateLimit })).toBeUndefined();
    expect(num.resolveExpiresAtMsFromDurationMs(600_000, { nowMs: dateLimit + 1 })).toBeUndefined();
    expect(num.resolveExpiresAtMsFromDurationSeconds("3600", { nowMs, bufferMs: 300 })).toBe(
      3_600_700,
    );
    expect(
      num.resolveExpiresAtMsFromDurationSeconds("10", {
        nowMs,
        bufferMs: 20_000,
        minRemainingMs: 30_000,
      }),
    ).toBe(31_000);
    expect(num.resolveExpiresAtMsFromDurationSeconds("3600", { nowMs: dateLimit })).toBeUndefined();
    expect(num.resolveExpiresAtMsFromDurationSeconds("1e309", { nowMs })).toBeUndefined();
    expect(num.resolveExpiresAtMsFromEpochSeconds(1234.9)).toBe(1_234_000);
    expect(num.resolveExpiresAtMsFromEpochSeconds("3600", { bufferMs: 300 })).toBe(3_599_700);
    expect(num.resolveExpiresAtMsFromEpochSeconds("100", { maxMs: 99_999 })).toBeUndefined();
    expect(num.resolveExpiresAtMsFromEpochSeconds(Number.MAX_SAFE_INTEGER)).toBeUndefined();
    expect(num.resolveExpiresAtMsFromEpochSeconds(8_640_000_000_001)).toBeUndefined();
    expect(num.resolveExpiresAtMsFromEpochSeconds("1e309")).toBeUndefined();
  });

  test("mixed expiry helper handles relative seconds, epoch seconds, and absolute milliseconds", () => {
    expect(num.resolveExpiresAtMsFromDurationOrEpoch(86_400, { nowMs: 1_700_000_000_000 })).toBe(
      1_700_086_400_000,
    );
    expect(num.resolveExpiresAtMsFromDurationOrEpoch(1_700_000_000)).toBe(1_700_000_000_000);
    expect(num.resolveExpiresAtMsFromDurationOrEpoch(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(num.resolveExpiresAtMsFromDurationOrEpoch(dateLimit + 1)).toBeUndefined();
    expect(num.resolveExpiresAtMsFromDurationOrEpoch(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(num.resolveExpiresAtMsFromDurationOrEpoch(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
  });

  test("integer option helpers floor finite values and fall back for non-finite values", () => {
    expect(num.resolveIntegerOption(7.9, 1, { min: 1, max: 10 })).toBe(7);
    expect(num.resolveIntegerOption(Number.NaN, 4.9, { min: 1 })).toBe(4);
    expect(num.resolveIntegerOption(-4, 1, { min: 0 })).toBe(0);
    expect(num.resolveIntegerOption(40, 1, { max: 10 })).toBe(10);
    expect(num.resolveNonNegativeIntegerOption(Number.NaN, 3.9)).toBe(3);
  });

  test("optional integer option helper rejects non-finite values", () => {
    expect(num.resolveOptionalIntegerOption(7.9, { min: 1, max: 10 })).toBe(7);
    expect(num.resolveOptionalIntegerOption(Number.NaN, { min: 1 })).toBeUndefined();
    expect(num.resolveOptionalIntegerOption(-4, { min: 0 })).toBe(0);
    expect(num.resolveOptionalIntegerOption(40, { max: 10 })).toBe(10);
  });
});
