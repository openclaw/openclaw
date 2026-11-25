import { expect, test } from "vitest";
import * as num from "./number-coercion.js";

const nowMs = 1_000;
const dateLimit = 8_640_000_000_000_000;
const timerLimit = num.MAX_TIMER_TIMEOUT_MS;
const epoch = "1970-01-01T00:00:00.000Z";
const epochSecond = "1970-01-01T00:00:01.000Z";
test.each([
  ["unsafe integer", 2 ** 53, 2 ** 53, 2 ** 53, 2 ** 53],
  ["zero", 0, undefined, 0, undefined],
  ["negative zero", -0, undefined, -0, undefined],
  ["negative integer", -1, undefined, undefined, undefined],
  ["positive fraction", 1.5, undefined, undefined, 1],
  ["fraction below one", 0.5, undefined, undefined, 0],
  ["NaN", Number.NaN, undefined, undefined, undefined],
  ["numeric string", "1", undefined, undefined, undefined],
])("integer policies for %s", (_name, input, positive, nonNegative, floored) => {
  expect(num.asPositiveInteger(input)).toBe(positive);
  expect(num.asNonNegativeInteger(input)).toBe(nonNegative);
  expect(num.floorPositiveFiniteNumber(input)).toBe(floored);
});

test.each([
  ["Unicode-trimmed signed zero", "\u00a0-0\u2003", -0, -0],
  ["unsafe integer", "9007199254740992", undefined, 9_007_199_254_740_992],
  ["scientific overflow", "1e309", undefined, undefined],
  ["scientific underflow", "-1e-400", undefined, -0],
  ["coercible object", { valueOf: (): number => 4 }, undefined, undefined],
])("preserves strict parser boundaries for %s", (_name, value, integer, finite) => {
  expect(num.parseStrictInteger(value)).toBe(integer);
  expect(num.parseStrictFiniteNumber(value)).toBe(finite);
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

test.each<[() => unknown, unknown]>([
  [() => num.asPositiveFiniteNumber(0.5), 0.5],
  [() => num.asPositiveFiniteNumber(0), undefined],
  [() => num.asPositiveFiniteNumber(Number.POSITIVE_INFINITY), undefined],
  [() => num.asNonNegativeFiniteNumber(0), 0],
  [() => num.asNonNegativeFiniteNumber(-0.5), undefined],
  [() => num.asNonNegativeFiniteNumber("1"), undefined],
  [() => num.asFiniteNumberInRange(0.5, { min: 0.5, max: 2 }), 0.5],
  [() => num.asFiniteNumberInRange(2, { min: 0.5, max: 2 }), 2],
  [() => num.asFiniteNumberInRange(0.5, { min: 0.5, minExclusive: true }), undefined],
  [() => num.asFiniteNumberInRange(10, { max: 10, maxExclusive: true }), undefined],
  [() => num.asFiniteNumberInRange("1", { min: 0, max: 2 }), undefined],
  [() => num.asSafeIntegerInRange(-1, { min: -1, max: 10 }), -1],
  [() => num.asSafeIntegerInRange(10, { min: -1, max: 10 }), 10],
  [() => num.asSafeIntegerInRange(1.5, { min: -1, max: 10 }), undefined],
  [() => num.asSafeIntegerInRange(11, { min: -1, max: 10 }), undefined],
  [() => num.asSafeIntegerInRange(Number.NaN, { min: -1, max: 10 }), undefined],
  [() => num.parseFiniteNumber(4), 4],
  [() => num.parseFiniteNumber("4.5"), 4.5],
  [() => num.parseFiniteNumber("4.5ms"), undefined],
  [() => num.parseFiniteNumber(""), undefined],
  [() => num.MAX_TIMER_TIMEOUT_SECONDS, 2_147_000],
  [() => num.finiteSecondsToTimerSafeMilliseconds(1.5), 1_500],
  [() => num.finiteSecondsToTimerSafeMilliseconds(1.5, { floorSeconds: true }), 1_000],
  [() => num.finiteSecondsToTimerSafeMilliseconds(10_000_000), timerLimit],
  [() => num.finiteSecondsToTimerSafeMilliseconds("10"), undefined],
  [() => num.finiteSecondsToTimerSafeMilliseconds(Number.POSITIVE_INFINITY), undefined],
  [() => num.clampTimerTimeoutMs(0, 10), 10],
  [() => num.clampTimerTimeoutMs(10_000_000_000), timerLimit],
  [() => num.clampTimerTimeoutMs(Number.NaN), undefined],
  [() => num.clampPositiveTimerTimeoutMs(0), undefined],
  [() => num.clampPositiveTimerTimeoutMs(10_000_000_000), timerLimit],
  [() => num.resolvePositiveTimerTimeoutMs(0, 5000), 5000],
  [() => num.resolvePositiveTimerTimeoutMs(Number.MAX_SAFE_INTEGER, 5000), timerLimit],
  [() => num.resolveTimerTimeoutMs(Number.NaN, 5000), 5000],
  [() => num.resolveTimerTimeoutMs(Number.NaN, 0, 0), 0],
  [() => num.resolveTimerTimeoutMs(Number.NaN, Number.POSITIVE_INFINITY, 25), 25],
  [() => num.resolveTimerTimeoutMs(Number.MAX_SAFE_INTEGER, 5000), timerLimit],
  [() => num.addTimerTimeoutGraceMs(10_000), 15_000],
  [() => num.addTimerTimeoutGraceMs(10_000, 500), 10_500],
  [() => num.addTimerTimeoutGraceMs(timerLimit - 100, 500), timerLimit],
  [() => num.addTimerTimeoutGraceMs(Number.NaN), undefined],
  [() => num.positiveSecondsToSafeMilliseconds("10"), 10_000],
  [() => num.positiveSecondsToSafeMilliseconds("0"), undefined],
  [() => num.positiveSecondsToSafeMilliseconds("1e309"), undefined],
  [() => num.nonNegativeSecondsToSafeMilliseconds("0"), 0],
  [() => num.nonNegativeSecondsToSafeMilliseconds("-1"), undefined],
  [() => num.isFutureDateTimestampMs(1_001, { nowMs }), true],
  [() => num.isFutureDateTimestampMs(1_000, { nowMs }), false],
  [() => num.isFutureDateTimestampMs(dateLimit + 1, { nowMs }), false],
  [() => num.isFutureDateTimestampMs(1_001, { nowMs: Number.NaN }), false],
  [() => num.resolveDateTimestampMs(1_000), 1_000],
  [() => num.resolveDateTimestampMs(Number.POSITIVE_INFINITY, 1_000), 1_000],
  [() => num.resolveDateTimestampMs(Number.POSITIVE_INFINITY, Number.NaN), 0],
  [() => num.resolveTimestampMsToIsoString(0), epoch],
  [() => num.resolveTimestampMsToIsoString(Number.POSITIVE_INFINITY, 1_000), epochSecond],
  [() => num.resolveTimestampMsToIsoString(Number.POSITIVE_INFINITY, Number.NaN), epoch],
  [
    () => num.timestampMsToIsoFileStamp(Date.parse("2026-02-23T12:34:56.000Z")),
    "2026-02-23T12-34-56.000Z",
  ],
  [() => num.timestampMsToIsoFileStamp(9_000_000_000_000_000, 1_000), "1970-01-01T00-00-01.000Z"],
  [() => num.resolveExpiresAtMsFromDurationMs(600_000, { nowMs }), 601_000],
  [() => num.resolveExpiresAtMsFromDurationMs(600_000, { nowMs: dateLimit }), undefined],
  [() => num.resolveExpiresAtMsFromDurationMs(600_000, { nowMs: dateLimit + 1 }), undefined],
  [() => num.resolveExpiresAtMsFromDurationSeconds("3600", { nowMs, bufferMs: 300 }), 3_600_700],
  [
    () =>
      num.resolveExpiresAtMsFromDurationSeconds("10", {
        nowMs,
        bufferMs: 20_000,
        minRemainingMs: 30_000,
      }),
    31_000,
  ],
  [() => num.resolveExpiresAtMsFromDurationSeconds("3600", { nowMs: dateLimit }), undefined],
  [() => num.resolveExpiresAtMsFromDurationSeconds("1e309", { nowMs }), undefined],
  [() => num.resolveExpiresAtMsFromEpochSeconds(1234.9), 1_234_000],
  [() => num.resolveExpiresAtMsFromEpochSeconds("3600", { bufferMs: 300 }), 3_599_700],
  [() => num.resolveExpiresAtMsFromEpochSeconds("100", { maxMs: 99_999 }), undefined],
  [() => num.resolveExpiresAtMsFromEpochSeconds(Number.MAX_SAFE_INTEGER), undefined],
  [() => num.resolveExpiresAtMsFromEpochSeconds(8_640_000_000_001), undefined],
  [() => num.resolveExpiresAtMsFromEpochSeconds("1e309"), undefined],
  [
    () => num.resolveExpiresAtMsFromDurationOrEpoch(86_400, { nowMs: 1_700_000_000_000 }),
    1_700_086_400_000,
  ],
  [() => num.resolveExpiresAtMsFromDurationOrEpoch(1_700_000_000), 1_700_000_000_000],
  [() => num.resolveExpiresAtMsFromDurationOrEpoch(1_700_000_000_000), 1_700_000_000_000],
  [() => num.resolveExpiresAtMsFromDurationOrEpoch(dateLimit + 1), undefined],
  [() => num.resolveExpiresAtMsFromDurationOrEpoch(Number.POSITIVE_INFINITY), undefined],
  [() => num.resolveExpiresAtMsFromDurationOrEpoch(Number.MAX_SAFE_INTEGER + 1), undefined],
  [() => num.resolveIntegerOption(7.9, 1, { min: 1, max: 10 }), 7],
  [() => num.resolveIntegerOption(Number.NaN, 4.9, { min: 1 }), 4],
  [() => num.resolveIntegerOption(-4, 1, { min: 0 }), 0],
  [() => num.resolveIntegerOption(40, 1, { max: 10 }), 10],
  [() => num.resolveNonNegativeIntegerOption(Number.NaN, 3.9), 3],
  [() => num.resolveOptionalIntegerOption(7.9, { min: 1, max: 10 }), 7],
  [() => num.resolveOptionalIntegerOption(Number.NaN, { min: 1 }), undefined],
  [() => num.resolveOptionalIntegerOption(-4, { min: 0 }), 0],
  [() => num.resolveOptionalIntegerOption(40, { max: 10 }), 10],
])("scalar coercion case %#", (read, expected) => {
  expect(read()).toBe(expected);
});
