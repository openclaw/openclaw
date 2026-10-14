// Usage accumulator tests cover multi-call token aggregation used for billing
// metadata on embedded run results.
import { describe, expect, it } from "vitest";
import {
  createUsageAccumulator,
  mergeAttemptRunStatsIntoAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "./usage-accumulator.js";

type UsageInput = NonNullable<Parameters<typeof mergeUsageIntoAccumulator>[1]>;

const FIRST_USAGE: UsageInput = {
  input: 100,
  output: 50,
  reasoningTokens: 12,
  cacheRead: 80_000,
  cacheWrite: 5_000,
  cacheWrite1h: 3_000,
  total: 85_150,
};

const SECOND_USAGE: UsageInput = {
  input: 120,
  output: 30,
  cacheRead: 82_000,
  cacheWrite: 0,
  total: 82_150,
};

const FINAL_USAGE: UsageInput = {
  input: 150,
  output: 40,
  reasoningTokens: 7,
  cacheRead: 84_000,
  cacheWrite: 0,
  contextUsage: {
    state: "available",
    promptTokens: 84_150,
    totalTokens: 84_190,
  },
  total: 84_190,
};

function createAccumulatorWithUsage(...usages: UsageInput[]) {
  // Helper feeds usage snapshots in order so tests can distinguish accumulated
  // totals from the exact final provider call.
  const acc = createUsageAccumulator();
  for (const usage of usages) {
    mergeUsageIntoAccumulator(acc, usage);
  }
  return acc;
}

describe("usage-accumulator", () => {
  describe("mergeUsageIntoAccumulator", () => {
    it("preserves complete zero accounting without a price across attempts", () => {
      const attempt = createAccumulatorWithUsage({
        input: 0,
        output: 0,
        total: 0,
        usageReport: { state: "available" },
      });
      const run = createUsageAccumulator();
      mergeUsageIntoAccumulator(run, toNormalizedUsage(attempt));
      expect(toNormalizedUsage(run)).toEqual({
        input: 0,
        output: 0,
        total: 0,
        usageReport: { state: "available" },
      });
    });

    it("does not present completed calls as a complete run total after an interrupted call", () => {
      const acc = createAccumulatorWithUsage(
        FIRST_USAGE,
        { usageReport: { state: "unavailable" } },
        FINAL_USAGE,
      );
      expect(toNormalizedUsage(acc)).toEqual({
        usageReport: { state: "unavailable" },
        contextUsage: { state: "unavailable" },
      });
    });
    it("accumulates usage across multiple API calls", () => {
      const acc = createAccumulatorWithUsage(FIRST_USAGE, SECOND_USAGE, FINAL_USAGE);

      expect(acc.input).toBe(370);
      expect(acc.output).toBe(120);
      expect(acc.reasoningTokens).toBe(19);
      expect(acc.cacheRead).toBe(246_000);
      expect(acc.cacheWrite).toBe(5_000);
      expect(toNormalizedUsage(acc)).toMatchObject({ cacheWrite1h: 3_000 });
      expect(acc.total).toBe(251_490);
    });

    it("carries complete costs across attempts without claiming provider provenance", () => {
      const firstAttempt = createAccumulatorWithUsage({
        input: 150_000,
        cost: { total: 0.125, totalOrigin: "provider-billed" },
      });
      const secondAttempt = createAccumulatorWithUsage({ input: 150_000, cost: { total: 0.5 } });
      const run = createUsageAccumulator();
      mergeUsageIntoAccumulator(run, toNormalizedUsage(firstAttempt));
      mergeUsageIntoAccumulator(run, toNormalizedUsage(secondAttempt));

      expect(toNormalizedUsage(run)?.cost).toEqual({ total: 0.625 });
      mergeUsageIntoAccumulator(run, { input: 1 });
      expect(toNormalizedUsage(run)?.cost).toBeUndefined();
      mergeUsageIntoAccumulator(run, { input: 1, cost: { total: 0.25 } });
      expect(toNormalizedUsage(run)?.cost).toBeUndefined();
    });

    it("preserves billed-zero provenance only while every contribution is billed", () => {
      const attempt = createAccumulatorWithUsage({
        input: 100,
        cost: { total: 0, totalOrigin: "provider-billed" },
      });
      const run = createUsageAccumulator();
      mergeUsageIntoAccumulator(run, toNormalizedUsage(attempt));
      expect(toNormalizedUsage(run)?.cost).toEqual({ total: 0, totalOrigin: "provider-billed" });

      mergeUsageIntoAccumulator(run, { input: 100, cost: { total: 0 } });
      expect(toNormalizedUsage(run)?.cost).toEqual({ total: 0 });
      mergeUsageIntoAccumulator(run, toNormalizedUsage(attempt));
      expect(toNormalizedUsage(run)?.cost).toEqual({ total: 0 });
    });

    it("ignores undefined or zero-only usage", () => {
      const acc = createUsageAccumulator();

      mergeUsageIntoAccumulator(acc, undefined);
      mergeUsageIntoAccumulator(acc, {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      });

      expect(acc).toEqual(createUsageAccumulator());
    });
  });

  describe("mergeAttemptRunStatsIntoAccumulator", () => {
    it("accumulates turns and bridge calls across retry/fallback attempts", () => {
      const acc = createUsageAccumulator();

      // First attempt makes bridge calls, then a retry/fallback attempt runs.
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
  });

  describe("toNormalizedUsage", () => {
    it("returns undefined for an empty accumulator", () => {
      expect(toNormalizedUsage(createUsageAccumulator())).toBeUndefined();
    });

    it("preserves reported zero cache counters across attempt and run totals", () => {
      const attempt = createAccumulatorWithUsage({ input: 100, cacheRead: 0, cacheWrite: 0 });
      const run = createUsageAccumulator();
      mergeUsageIntoAccumulator(run, toNormalizedUsage(attempt));
      expect(toNormalizedUsage(run)).toMatchObject({
        input: 100,
        cacheRead: 0,
        cacheWrite: 0,
        total: 100,
      });
      expect(toNormalizedUsage(createAccumulatorWithUsage({ input: 100 }))).toMatchObject({
        cacheRead: undefined,
        cacheWrite: undefined,
      });
    });
  });
});
