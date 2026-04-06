import { describe, expect, it } from "vitest";
import {
  getBootstrapProfileConfig,
  resolveBootstrapBudgetForModel,
  resolveBootstrapTotalMaxChars,
  DEFAULT_BOOTSTRAP_MAX_CHARS,
  DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS,
} from "./pi-embedded-helpers.js";

describe("getBootstrapProfileConfig", () => {
  it("normal profile returns default limits", () => {
    const config = getBootstrapProfileConfig("normal");
    expect(config.maxCharsPerFile).toBe(DEFAULT_BOOTSTRAP_MAX_CHARS);
    expect(config.totalMaxChars).toBe(DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS);
  });

  it("reduced profile has lower limits than normal", () => {
    const normal = getBootstrapProfileConfig("normal");
    const reduced = getBootstrapProfileConfig("reduced");
    expect(reduced.maxCharsPerFile).toBeLessThan(normal.maxCharsPerFile);
    expect(reduced.totalMaxChars).toBeLessThan(normal.totalMaxChars);
    expect(reduced.maxCharsPerFile).toBe(10_000);
    expect(reduced.totalMaxChars).toBe(50_000);
  });

  it("minimal profile has the lowest limits", () => {
    const reduced = getBootstrapProfileConfig("reduced");
    const minimal = getBootstrapProfileConfig("minimal");
    expect(minimal.maxCharsPerFile).toBeLessThan(reduced.maxCharsPerFile);
    expect(minimal.totalMaxChars).toBeLessThan(reduced.totalMaxChars);
    expect(minimal.maxCharsPerFile).toBe(5_000);
    expect(minimal.totalMaxChars).toBe(20_000);
  });
});

describe("resolveBootstrapBudgetForModel", () => {
  it("returns capped totalMaxChars for large context windows", () => {
    // 200K token window: reserve = max(60K, 30K) = 60K, available = 140K, chars = 560K → capped at 150K
    const budget = resolveBootstrapBudgetForModel(200_000);
    expect(budget.totalMaxChars).toBe(DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS);
  });

  it("returns floored totalMaxChars for tiny context windows", () => {
    // 1K token window: reserve = max(300, 30K) = 30K, available = -29K → chars = floor(-29K*4) → floor at 20K
    const budget = resolveBootstrapBudgetForModel(1_000);
    expect(budget.totalMaxChars).toBe(20_000);
  });

  it("scales appropriately for mid-range context windows", () => {
    // 50K token window: reserve = max(15K, 30K) = 30K, available = 20K, chars = 80K → below cap
    const budget = resolveBootstrapBudgetForModel(50_000);
    expect(budget.totalMaxChars).toBe(80_000);
    expect(budget.totalMaxChars).toBeLessThan(DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS);
  });

  it("applies 30K minimum reserve", () => {
    // 60K token window: reserve = max(18K, 30K) = 30K, available = 30K, chars = 120K
    const budget = resolveBootstrapBudgetForModel(60_000);
    expect(budget.totalMaxChars).toBe(120_000);
  });

  it("preserves default maxCharsPerFile", () => {
    const budget = resolveBootstrapBudgetForModel(100_000);
    expect(budget.maxCharsPerFile).toBe(DEFAULT_BOOTSTRAP_MAX_CHARS);
  });

  it("totalMaxChars is always at least 20K", () => {
    for (const tokens of [0.001, 100, 1_000, 10_000]) {
      const budget = resolveBootstrapBudgetForModel(tokens);
      expect(budget.totalMaxChars).toBeGreaterThanOrEqual(20_000);
    }
  });

  it("totalMaxChars never exceeds DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS", () => {
    for (const tokens of [100_000, 500_000, 1_000_000]) {
      const budget = resolveBootstrapBudgetForModel(tokens);
      expect(budget.totalMaxChars).toBeLessThanOrEqual(DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS);
    }
  });
});

describe("resolveBootstrapTotalMaxChars with contextWindowTokens", () => {
  it("returns config value when set, ignoring contextWindowTokens", () => {
    const cfg = { agents: { defaults: { bootstrapTotalMaxChars: 75_000 } } } as Parameters<
      typeof resolveBootstrapTotalMaxChars
    >[0];
    const result = resolveBootstrapTotalMaxChars(cfg, 200_000);
    expect(result).toBe(75_000);
  });

  it("uses contextWindowTokens when config is not set", () => {
    // 50K token window → resolveBootstrapBudgetForModel gives 80K
    const result = resolveBootstrapTotalMaxChars(undefined, 50_000);
    expect(result).toBe(80_000);
  });

  it("returns default when neither config nor contextWindowTokens is set", () => {
    const result = resolveBootstrapTotalMaxChars();
    expect(result).toBe(DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS);
  });

  it("ignores contextWindowTokens of 0", () => {
    const result = resolveBootstrapTotalMaxChars(undefined, 0);
    expect(result).toBe(DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS);
  });
});
