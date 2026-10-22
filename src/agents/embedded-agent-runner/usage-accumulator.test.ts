import { describe, expect, it } from "vitest";
import {
  createUsageAccumulator,
  mergeAttemptRunStatsIntoAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "./usage-accumulator.js";

type UsageInput = NonNullable<Parameters<typeof mergeUsageIntoAccumulator>[1]>;
const ZERO_USAGE = { input: 0, output: 0, total: 0 };
const FIRST_USAGE: UsageInput = {
  input: 100,
  output: 50,
  reasoningTokens: 12,
  cacheRead: 80_000,
  cacheWrite: 5_000,
  cacheWrite1h: 3_000,
  cacheWrite5m: 2_000,
  total: 85_150,
};
const FINAL_USAGE: UsageInput = {
  input: 150,
  output: 40,
  reasoningTokens: 7,
  cacheRead: 84_000,
  cacheWrite: 0,
  total: 84_190,
};
function createAccumulatorWithUsage(...usages: (UsageInput | undefined)[]) {
  const acc = createUsageAccumulator();
  for (const usage of usages) {
    mergeUsageIntoAccumulator(acc, usage);
  }
  return acc;
}
function normalizedAttempt(...usages: (UsageInput | undefined)[]) {
  return toNormalizedUsage(createAccumulatorWithUsage(...usages));
}

describe("usage-accumulator", () => {
  it("preserves complete zero accounting without a price across attempts", () => {
    const zero: UsageInput = { ...ZERO_USAGE, usageReport: { state: "available" } };
    expect(normalizedAttempt(normalizedAttempt(zero))).toEqual({
      input: 0,
      output: 0,
      total: 0,
      usageReport: { state: "available" },
    });
  });

  it("does not present completed calls as a complete run total after an interrupted call", () => {
    expect(
      normalizedAttempt(FIRST_USAGE, { usageReport: { state: "unavailable" } }, FINAL_USAGE),
    ).toEqual({
      usageReport: { state: "unavailable" },
      contextUsage: { state: "unavailable" },
    });
  });

  it("accumulates usage across multiple API calls", () => {
    const acc = createAccumulatorWithUsage(
      FIRST_USAGE,
      { input: 120, output: 30, cacheRead: 82_000, cacheWrite: 0, total: 82_150 },
      FINAL_USAGE,
    );
    expect(acc).toMatchObject({
      input: 370,
      output: 120,
      reasoningTokens: 19,
      cacheRead: 246_000,
      cacheWrite: 5_000,
      total: 251_490,
    });
    expect(toNormalizedUsage(acc)).toMatchObject({ cacheWrite1h: 3_000, cacheWrite5m: 2_000 });
  });

  it("carries complete costs across attempts without claiming provider provenance", () => {
    const run = createAccumulatorWithUsage(
      normalizedAttempt({ input: 150_000, cost: { total: 0.125, totalOrigin: "provider-billed" } }),
      normalizedAttempt({ input: 150_000, cost: { total: 0.5 } }),
    );
    expect(toNormalizedUsage(run)?.cost).toEqual({ total: 0.625 });
    mergeUsageIntoAccumulator(run, { input: 1 });
    expect(toNormalizedUsage(run)?.cost).toBeUndefined();
    mergeUsageIntoAccumulator(run, { input: 1, cost: { total: 0.25 } });
    expect(toNormalizedUsage(run)?.cost).toBeUndefined();
  });

  it("preserves billed-zero provenance only while every contribution is billed", () => {
    const attempt = normalizedAttempt({
      input: 100,
      cost: { total: 0, totalOrigin: "provider-billed" },
    });
    const run = createAccumulatorWithUsage(attempt);
    expect(toNormalizedUsage(run)?.cost).toEqual({ total: 0, totalOrigin: "provider-billed" });
    mergeUsageIntoAccumulator(run, { input: 100, cost: { total: 0 } });
    expect(toNormalizedUsage(run)?.cost).toEqual({ total: 0 });
    mergeUsageIntoAccumulator(run, attempt);
    expect(toNormalizedUsage(run)?.cost).toEqual({ total: 0 });
  });

  it("ignores undefined or zero-only usage", () => {
    expect(
      createAccumulatorWithUsage(undefined, { ...ZERO_USAGE, cacheRead: 0, cacheWrite: 0 }),
    ).toEqual(createUsageAccumulator());
  });

  it("accumulates turns and bridge calls across retry/fallback attempts", () => {
    const acc = createUsageAccumulator();
    mergeAttemptRunStatsIntoAccumulator(acc, {
      assistantTurns: 2,
      bridgeCalls: { search: 1, describe: 2, call: 3 },
    });
    mergeAttemptRunStatsIntoAccumulator(acc, {
      assistantTurns: 1,
      bridgeCalls: { search: 0, describe: 1, call: 4 },
    });
    expect(acc.assistantTurns).toBe(3);
    expect(acc.bridgeCalls).toEqual({ search: 1, describe: 3, call: 7 });
  });

  it("keeps bridgeCalls absent for catalog-less attempts", () => {
    const acc = createUsageAccumulator();
    mergeAttemptRunStatsIntoAccumulator(acc, { assistantTurns: 1 });
    expect(acc.assistantTurns).toBe(1);
    expect(acc.bridgeCalls).toBeUndefined();
  });

  it("preserves reported zero cache counters across attempt and run totals", () => {
    expect(
      normalizedAttempt(normalizedAttempt({ input: 100, cacheRead: 0, cacheWrite: 0 })),
    ).toMatchObject({
      input: 100,
      cacheRead: 0,
      cacheWrite: 0,
      total: 100,
    });
    expect(normalizedAttempt({ input: 100 })).toMatchObject({
      cacheRead: undefined,
      cacheWrite: undefined,
    });
  });

  it("accumulates both TTL buckets across attempt and run totals", () => {
    const attempt = createAccumulatorWithUsage(FIRST_USAGE, {
      cacheWrite: 10,
      cacheWrite1h: 4,
      cacheWrite5m: 6,
    });
    const run = createUsageAccumulator();
    mergeUsageIntoAccumulator(run, toNormalizedUsage(attempt));
    mergeUsageIntoAccumulator(run, { cacheWrite: 5, cacheWrite5m: 5 });
    expect(toNormalizedUsage(run)).toMatchObject({
      cacheWrite: 5_015,
      cacheWrite1h: 3_004,
      cacheWrite5m: 2_011,
    });
  });

  it.each(["cacheWrite1h", "cacheWrite5m"] as const)(
    "preserves a reported zero %s across attempt and run totals without inventing its sibling",
    (bucket) => {
      const attempt = createAccumulatorWithUsage({ input: 100, cacheWrite: 10, [bucket]: 0 });
      const run = createUsageAccumulator();
      mergeUsageIntoAccumulator(run, toNormalizedUsage(attempt));
      mergeUsageIntoAccumulator(run, { input: 50 });
      const normalized = toNormalizedUsage(run);
      expect(normalized).toMatchObject({ input: 150, cacheWrite: 10, [bucket]: 0 });
      const sibling = bucket === "cacheWrite1h" ? "cacheWrite5m" : "cacheWrite1h";
      expect(normalized).not.toHaveProperty(sibling);
    },
  );

  it("keeps both TTL buckets absent when no attempt reports a breakdown", () => {
    const attempt = createAccumulatorWithUsage({ input: 100, cacheWrite: 10 });
    const run = createUsageAccumulator();
    mergeUsageIntoAccumulator(run, toNormalizedUsage(attempt));
    expect(toNormalizedUsage(run)).not.toHaveProperty("cacheWrite1h");
    expect(toNormalizedUsage(run)).not.toHaveProperty("cacheWrite5m");
  });
});
