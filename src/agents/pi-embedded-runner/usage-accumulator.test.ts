import { describe, expect, it } from "vitest";
import { normalizeUsage } from "../usage.js";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
  toLastCallUsage,
  toNormalizedUsage,
} from "./usage-accumulator.js";

describe("UsageAccumulator", () => {
  describe("mergeUsageIntoAccumulator", () => {
    it("accumulates input/output/cache across multiple API calls", () => {
      const acc = createUsageAccumulator();

      // Simulate 3 tool-call round-trips with prompt caching.
      // Each call reports its own input + cache tokens.
      mergeUsageIntoAccumulator(acc, {
        input: 100,
        output: 50,
        cacheRead: 80_000,
        cacheWrite: 5_000,
        total: 85_150,
      });
      mergeUsageIntoAccumulator(acc, {
        input: 120,
        output: 30,
        cacheRead: 82_000,
        cacheWrite: 0,
        total: 82_150,
      });
      mergeUsageIntoAccumulator(acc, {
        input: 150,
        output: 40,
        cacheRead: 84_000,
        cacheWrite: 0,
        total: 84_190,
      });

      // Accumulated totals reflect the sum of all calls.
      expect(acc.input).toBe(370);
      expect(acc.output).toBe(120);
      expect(acc.cacheRead).toBe(246_000);
      expect(acc.cacheWrite).toBe(5_000);

      // Last-call fields reflect only the final API call.
      expect(acc.lastInput).toBe(150);
      expect(acc.lastCacheRead).toBe(84_000);
      expect(acc.lastCacheWrite).toBe(0);
    });

    it("ignores undefined/null usage", () => {
      const acc = createUsageAccumulator();
      mergeUsageIntoAccumulator(acc, undefined);
      expect(acc.input).toBe(0);
      expect(acc.output).toBe(0);
    });
  });

  describe("toNormalizedUsage", () => {
    it("returns undefined for a zero accumulator", () => {
      expect(toNormalizedUsage(createUsageAccumulator())).toBeUndefined();
    });

    it("returns accumulated input/cacheRead/cacheWrite for cost tracking (#53734)", () => {
      const acc = createUsageAccumulator();

      // Simulate a multi-call turn (3 tool-use round-trips with caching).
      mergeUsageIntoAccumulator(acc, {
        input: 100,
        output: 50,
        cacheRead: 80_000,
        cacheWrite: 5_000,
      });
      mergeUsageIntoAccumulator(acc, {
        input: 120,
        output: 30,
        cacheRead: 82_000,
        cacheWrite: 0,
      });
      mergeUsageIntoAccumulator(acc, {
        input: 150,
        output: 40,
        cacheRead: 84_000,
        cacheWrite: 0,
      });

      const usage = toNormalizedUsage(acc);
      expect(usage).toBeDefined();

      // Cost tracking needs accumulated totals — the sum of all API calls
      // in the turn, not just the last call's values.
      expect(usage!.input).toBe(370); // 100 + 120 + 150
      expect(usage!.output).toBe(120); // 50 + 30 + 40
      expect(usage!.cacheRead).toBe(246_000); // 80k + 82k + 84k
      expect(usage!.cacheWrite).toBe(5_000); // 5k + 0 + 0
    });

    it("omits zero fields as undefined", () => {
      const acc = createUsageAccumulator();
      mergeUsageIntoAccumulator(acc, { input: 100, output: 50 });

      const usage = toNormalizedUsage(acc);
      expect(usage).toBeDefined();
      expect(usage!.input).toBe(100);
      expect(usage!.output).toBe(50);
      expect(usage!.cacheRead).toBeUndefined();
      expect(usage!.cacheWrite).toBeUndefined();
    });
  });

  describe("toLastCallUsage", () => {
    it("returns last-call snapshot for context-size fallback", () => {
      const acc = createUsageAccumulator();

      mergeUsageIntoAccumulator(acc, {
        input: 100,
        output: 50,
        cacheRead: 80_000,
        cacheWrite: 5_000,
      });
      mergeUsageIntoAccumulator(acc, {
        input: 150,
        output: 40,
        cacheRead: 84_000,
        cacheWrite: 0,
      });

      const snapshot = toLastCallUsage(acc);
      expect(snapshot).toBeDefined();
      // Should reflect only the last API call's prompt-side fields.
      expect(snapshot!.input).toBe(150);
      expect(snapshot!.cacheRead).toBe(84_000);
      expect(snapshot!.cacheWrite).toBeUndefined(); // last call had 0
      // Output is accumulated (total generated text in the turn).
      expect(snapshot!.output).toBe(90);
    });

    it("returns undefined for a zero accumulator", () => {
      expect(toLastCallUsage(createUsageAccumulator())).toBeUndefined();
    });

    it("serves as fallback when lastAssistant exists but usage is absent", () => {
      // Reproduces the edge steipete identified: lastAssistant is truthy but
      // lastAssistant.usage is undefined, so normalizeUsage returns undefined.
      // The composition `normalizeUsage(...) ?? toLastCallUsage(acc)` must
      // still yield a context-size snapshot from the accumulator.
      const acc = createUsageAccumulator();
      mergeUsageIntoAccumulator(acc, {
        input: 200,
        output: 60,
        cacheRead: 90_000,
        cacheWrite: 3_000,
      });

      // Simulate: lastAssistant present but usage absent.
      const lastAssistant = { content: [{ type: "text", text: "ok" }] };
      const lastCallUsage =
        normalizeUsage((lastAssistant as { usage?: unknown }).usage as undefined) ??
        toLastCallUsage(acc);

      expect(lastCallUsage).toBeDefined();
      expect(lastCallUsage!.input).toBe(200);
      expect(lastCallUsage!.cacheRead).toBe(90_000);
      expect(lastCallUsage!.cacheWrite).toBe(3_000);
    });
  });
});
