import { describe, expect, it } from "vitest";
import {
  computeCacheUtilization,
  formatCacheUtilizationSummary,
  type CacheUtilizationMetrics,
} from "./cache-utilization.js";

describe("computeCacheUtilization", () => {
  it("computes cache hit ratio when cache read is present", () => {
    const metrics = computeCacheUtilization({
      input: 1000,
      output: 500,
      cacheRead: 2000,
      cacheWrite: 300,
    });
    expect(metrics.cacheHitTokens).toBe(2000);
    expect(metrics.cacheMissTokens).toBe(1300); // input + cacheWrite
    expect(metrics.totalPromptTokens).toBe(3300); // input + cacheRead + cacheWrite
    expect(metrics.cacheHitRatio).toBeCloseTo(0.606, 2); // 2000 / 3300
  });

  it("handles zero cache read (all cache misses)", () => {
    const metrics = computeCacheUtilization({
      input: 1000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 500,
    });
    expect(metrics.cacheHitTokens).toBe(0);
    expect(metrics.cacheMissTokens).toBe(1500);
    expect(metrics.totalPromptTokens).toBe(1500);
    expect(metrics.cacheHitRatio).toBe(0);
  });

  it("handles all cache hits (warm cache)", () => {
    const metrics = computeCacheUtilization({
      input: 0,
      output: 500,
      cacheRead: 5000,
      cacheWrite: 0,
    });
    expect(metrics.cacheHitTokens).toBe(5000);
    expect(metrics.cacheMissTokens).toBe(0);
    expect(metrics.totalPromptTokens).toBe(5000);
    expect(metrics.cacheHitRatio).toBe(1);
  });

  it("handles undefined cache fields", () => {
    const metrics = computeCacheUtilization({
      input: 1000,
      output: 500,
    });
    expect(metrics.cacheHitTokens).toBe(0);
    expect(metrics.cacheMissTokens).toBe(1000);
    expect(metrics.totalPromptTokens).toBe(1000);
    expect(metrics.cacheHitRatio).toBe(0);
  });

  it("handles undefined input", () => {
    const metrics = computeCacheUtilization({});
    expect(metrics.cacheHitTokens).toBe(0);
    expect(metrics.cacheMissTokens).toBe(0);
    expect(metrics.totalPromptTokens).toBe(0);
    expect(metrics.cacheHitRatio).toBe(0);
  });

  it("handles null usage", () => {
    const metrics = computeCacheUtilization(null);
    expect(metrics.cacheHitTokens).toBe(0);
    expect(metrics.cacheMissTokens).toBe(0);
    expect(metrics.totalPromptTokens).toBe(0);
    expect(metrics.cacheHitRatio).toBe(0);
  });
});

describe("formatCacheUtilizationSummary", () => {
  it("formats cache utilization as human-readable string", () => {
    const metrics: CacheUtilizationMetrics = {
      cacheHitTokens: 2000,
      cacheMissTokens: 1000,
      totalPromptTokens: 3000,
      cacheHitRatio: 0.667,
    };
    const summary = formatCacheUtilizationSummary(metrics);
    expect(summary).toBe("cache: 66.7% hit (2000/3000 tokens)");
  });

  it("formats zero cache utilization", () => {
    const metrics: CacheUtilizationMetrics = {
      cacheHitTokens: 0,
      cacheMissTokens: 1000,
      totalPromptTokens: 1000,
      cacheHitRatio: 0,
    };
    const summary = formatCacheUtilizationSummary(metrics);
    expect(summary).toBe("cache: 0.0% hit (0/1000 tokens)");
  });

  it("formats perfect cache utilization", () => {
    const metrics: CacheUtilizationMetrics = {
      cacheHitTokens: 5000,
      cacheMissTokens: 0,
      totalPromptTokens: 5000,
      cacheHitRatio: 1,
    };
    const summary = formatCacheUtilizationSummary(metrics);
    expect(summary).toBe("cache: 100.0% hit (5000/5000 tokens)");
  });

  it("returns empty string for zero total tokens", () => {
    const metrics: CacheUtilizationMetrics = {
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      totalPromptTokens: 0,
      cacheHitRatio: 0,
    };
    const summary = formatCacheUtilizationSummary(metrics);
    expect(summary).toBe("");
  });
});
