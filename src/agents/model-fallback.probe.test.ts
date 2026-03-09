import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { makeModelFallbackCfg } from "./test-helpers/model-fallback-config-fixture.js";

// Mock auth-profiles module — must be before importing model-fallback
vi.mock("./auth-profiles.js", () => ({
  ensureAuthProfileStore: vi.fn(),
  getSoonestCooldownExpiry: vi.fn(),
  isProfileInCooldown: vi.fn(),
  resolveProfilesUnavailableReason: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
}));

import {
  ensureAuthProfileStore,
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  resolveProfilesUnavailableReason,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
import { _probeThrottleInternals, runWithModelFallback } from "./model-fallback.js";

const mockedEnsureAuthProfileStore = vi.mocked(ensureAuthProfileStore);
const mockedGetSoonestCooldownExpiry = vi.mocked(getSoonestCooldownExpiry);
const mockedIsProfileInCooldown = vi.mocked(isProfileInCooldown);
const mockedResolveProfilesUnavailableReason = vi.mocked(resolveProfilesUnavailableReason);
const mockedResolveAuthProfileOrder = vi.mocked(resolveAuthProfileOrder);

const makeCfg = makeModelFallbackCfg;

function expectFallbackUsed(
  result: { result: unknown; attempts: Array<{ reason?: string }> },
  run: {
    (...args: unknown[]): unknown;
    mock: { calls: unknown[][] };
  },
) {
  expect(result.result).toBe("ok");
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith("anthropic", "claude-haiku-3-5");
  expect(result.attempts[0]?.reason).toBe("rate_limit");
}

describe("runWithModelFallback – cooldown respect", () => {
  let realDateNow: () => number;
  const NOW = 1_700_000_000_000;

  const runPrimaryCandidate = (
    cfg: OpenClawConfig,
    run: (provider: string, model: string) => Promise<unknown>,
  ) =>
    runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

  beforeEach(() => {
    realDateNow = Date.now;
    Date.now = vi.fn(() => NOW);

    // Clear throttle state between tests
    _probeThrottleInternals.lastProbeAttempt.clear();

    // Default: ensureAuthProfileStore returns a fake store
    const fakeStore: AuthProfileStore = {
      version: 1,
      profiles: {},
    };
    mockedEnsureAuthProfileStore.mockReturnValue(fakeStore);

    // Default: resolveAuthProfileOrder returns profiles only for "openai" provider
    mockedResolveAuthProfileOrder.mockImplementation(({ provider }: { provider: string }) => {
      if (provider === "openai") {
        return ["openai-profile-1"];
      }
      if (provider === "anthropic") {
        return ["anthropic-profile-1"];
      }
      if (provider === "google") {
        return ["google-profile-1"];
      }
      return [];
    });
    // Default: only openai profiles are in cooldown; fallback providers are available
    mockedIsProfileInCooldown.mockImplementation((_store, profileId: string) => {
      return profileId.startsWith("openai");
    });
    mockedResolveProfilesUnavailableReason.mockReturnValue("rate_limit");
  });

  afterEach(() => {
    Date.now = realDateNow;
    vi.restoreAllMocks();
  });

  it("skips primary model when far from cooldown expiry (30 min remaining)", async () => {
    const cfg = makeCfg();
    const expiresIn30Min = NOW + 30 * 60 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(expiresIn30Min);

    const run = vi.fn().mockResolvedValue("ok");

    const result = await runPrimaryCandidate(cfg, run);

    // Should skip primary and use fallback
    expectFallbackUsed(result, run);
  });

  it("uses inferred unavailable reason when skipping a cooldowned primary model", async () => {
    const cfg = makeCfg();
    const expiresIn30Min = NOW + 30 * 60 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(expiresIn30Min);
    mockedResolveProfilesUnavailableReason.mockReturnValue("billing");

    const run = vi.fn().mockResolvedValue("ok");

    const result = await runPrimaryCandidate(cfg, run);

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("anthropic", "claude-haiku-3-5");
    expect(result.attempts[0]?.reason).toBe("billing");
  });

  it("skips primary model even when close to cooldown expiry (1 min remaining)", async () => {
    const cfg = makeCfg();
    // Cooldown expires in 1 minute — still active, no early probing
    const expiresIn1Min = NOW + 60 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(expiresIn1Min);

    const run = vi.fn().mockResolvedValue("ok");

    const result = await runPrimaryCandidate(cfg, run);

    // No early probing: skip primary and use fallback
    expectFallbackUsed(result, run);
  });

  it("attempts primary model when cooldown already expired (safety valve)", async () => {
    const cfg = makeCfg();
    // Cooldown expired 5 min ago — shouldProbe returns true as safety valve
    const expiredAlready = NOW - 5 * 60 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(expiredAlready);

    const run = vi.fn().mockResolvedValue("recovered");

    const result = await runPrimaryCandidate(cfg, run);
    // Run is called without allowRateLimitCooldownProbe (no longer set)
    expect(result.result).toBe("recovered");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("openai", "gpt-4.1-mini");
  });

  it("skips all same-provider models when all profiles in cooldown", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5", "google/gemini-2-flash"],
          },
        },
      },
    } as Partial<OpenClawConfig>);

    // ALL providers in cooldown
    mockedIsProfileInCooldown.mockReturnValue(true);

    const almostExpired = NOW + 30 * 1000; // 30s remaining
    mockedGetSoonestCooldownExpiry.mockReturnValue(almostExpired);

    const run = vi.fn().mockResolvedValue("unreachable");

    // All providers in cooldown — should fail without making any API calls
    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        run,
      }),
    ).rejects.toThrow("All models failed");

    expect(run).not.toHaveBeenCalled();
  });

  it("throttles probe when called within 30s interval", async () => {
    const cfg = makeCfg();
    // Cooldown expired — would normally be probe-worthy
    const expiredAlready = NOW - 5 * 60 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(expiredAlready);

    // But a probe happened 10s ago → throttled
    _probeThrottleInternals.lastProbeAttempt.set("openai", NOW - 10_000);

    const run = vi.fn().mockResolvedValue("ok");

    const result = await runPrimaryCandidate(cfg, run);

    // Should be throttled → skip primary, use fallback
    expectFallbackUsed(result, run);
  });

  it("allows attempt when 30s have passed since last probe and cooldown expired", async () => {
    const cfg = makeCfg();
    // Cooldown already expired
    const expiredAlready = NOW - 5 * 60 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(expiredAlready);

    // Last probe was 31s ago — not throttled
    _probeThrottleInternals.lastProbeAttempt.set("openai", NOW - 31_000);

    const run = vi.fn().mockResolvedValue("probed-ok");

    const result = await runPrimaryCandidate(cfg, run);
    expect(result.result).toBe("probed-ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("openai", "gpt-4.1-mini");
  });

  it("handles non-finite soonest safely (treats as probe-worthy)", async () => {
    const cfg = makeCfg();

    // Infinity — not finite, so shouldProbe returns true as safety fallback
    mockedGetSoonestCooldownExpiry.mockReturnValue(Infinity);

    const run = vi.fn().mockResolvedValue("ok-infinity");

    const result = await runPrimaryCandidate(cfg, run);
    expect(result.result).toBe("ok-infinity");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("openai", "gpt-4.1-mini");
  });

  it("handles NaN soonest safely (treats as probe-worthy)", async () => {
    const cfg = makeCfg();

    mockedGetSoonestCooldownExpiry.mockReturnValue(NaN);

    const run = vi.fn().mockResolvedValue("ok-nan");

    const result = await runPrimaryCandidate(cfg, run);
    expect(result.result).toBe("ok-nan");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("openai", "gpt-4.1-mini");
  });

  it("handles null soonest safely (treats as probe-worthy)", async () => {
    const cfg = makeCfg();

    mockedGetSoonestCooldownExpiry.mockReturnValue(null);

    const run = vi.fn().mockResolvedValue("ok-null");

    const result = await runPrimaryCandidate(cfg, run);
    expect(result.result).toBe("ok-null");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("openai", "gpt-4.1-mini");
  });

  it("single candidate skips with rate_limit and exhausts candidates", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: [],
          },
        },
      },
    } as Partial<OpenClawConfig>);

    const almostExpired = NOW + 30 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(almostExpired);

    const run = vi.fn().mockResolvedValue("unreachable");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        fallbacksOverride: [],
        run,
      }),
    ).rejects.toThrow("All models failed");

    expect(run).not.toHaveBeenCalled();
  });

  it("respects cooldown per-provider — different providers skip independently", async () => {
    const cfg = makeCfg();
    const almostExpired = NOW + 30 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(almostExpired);

    const run = vi.fn().mockResolvedValue("ok");

    // First agent call: openai primary skipped → anthropic fallback used
    const result1 = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      agentDir: "/tmp/agent-a",
      run,
    });

    // Second agent call: same behavior for different agent dir
    const result2 = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      agentDir: "/tmp/agent-b",
      run,
    });

    // Both should use the fallback (anthropic), not the cooldowned primary (openai)
    expect(result1.result).toBe("ok");
    expect(result2.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, "anthropic", "claude-haiku-3-5");
    expect(run).toHaveBeenNthCalledWith(2, "anthropic", "claude-haiku-3-5");
  });

  it("skips billing-cooldowned primary when no fallback candidates exist", async () => {
    const cfg = makeCfg({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: [],
          },
        },
      },
    } as Partial<OpenClawConfig>);

    // Billing cooldown far from expiry — would normally be skipped
    const expiresIn30Min = NOW + 30 * 60 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(expiresIn30Min);
    mockedResolveProfilesUnavailableReason.mockReturnValue("billing");

    await expect(
      runWithModelFallback({
        cfg,
        provider: "openai",
        model: "gpt-4.1-mini",
        fallbacksOverride: [],
        run: vi.fn().mockResolvedValue("billing-recovered"),
      }),
    ).rejects.toThrow("All models failed");
  });

  it("skips billing-cooldowned primary even when close to cooldown expiry", async () => {
    const cfg = makeCfg();
    // Cooldown expires in 1 minute — still active, no early probing
    const expiresIn1Min = NOW + 60 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(expiresIn1Min);
    mockedResolveProfilesUnavailableReason.mockReturnValue("billing");

    const run = vi.fn().mockResolvedValue("ok");

    const result = await runPrimaryCandidate(cfg, run);

    // No probing during active cooldown — use fallback
    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("anthropic", "claude-haiku-3-5");
  });

  it("skips billing-cooldowned primary with fallbacks when far from cooldown expiry", async () => {
    const cfg = makeCfg();
    const expiresIn30Min = NOW + 30 * 60 * 1000;
    mockedGetSoonestCooldownExpiry.mockReturnValue(expiresIn30Min);
    mockedResolveProfilesUnavailableReason.mockReturnValue("billing");

    const run = vi.fn().mockResolvedValue("ok");

    const result = await runPrimaryCandidate(cfg, run);

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("anthropic", "claude-haiku-3-5");
    expect(result.attempts[0]?.reason).toBe("billing");
  });
});
