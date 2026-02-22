import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { FailoverError } from "./failover-error.js";
import { runWithModelFallback } from "./model-fallback.js";

/**
 * Regression tests for #19249: fallback models configured in
 * agents.defaults.model.fallbacks must bypass the agents.defaults.models
 * allowlist so that runtime failover actually reaches them.
 */
describe("runWithModelFallback – allowlist bypass (#19249)", () => {
  it("fallback models bypass the models allowlist", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["openrouter/deepseek/deepseek-v3.2"],
          },
          // This creates an allowlist that does NOT include the fallback model
          models: {
            "openai/gpt-4.1-mini": {},
          },
        },
      },
    } as OpenClawConfig;

    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limit"), { status: 429 }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("deepseek/deepseek-v3.2");
  });

  it("fallback models are reached on FailoverError from embedded runner", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-5-20250929",
            fallbacks: ["openrouter/deepseek/deepseek-v3.2", "openrouter/moonshotai/kimi-k2.5"],
          },
          // Allowlist that only includes the primary
          models: {
            "anthropic/claude-sonnet-4-5-20250929": {},
          },
        },
      },
    } as OpenClawConfig;

    const failoverErr = new FailoverError("⚠️ API rate limit reached. Please try again later.", {
      reason: "rate_limit",
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      status: 429,
    });

    const run = vi.fn().mockRejectedValueOnce(failoverErr).mockResolvedValueOnce("fallback-ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      run,
    });

    expect(result.result).toBe("fallback-ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("deepseek/deepseek-v3.2");
  });

  it("without allowlist, fallbacks still work (baseline)", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-haiku-3-5"],
          },
          // No models key = no allowlist
        },
      },
    } as OpenClawConfig;

    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limit"), { status: 429 }))
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-haiku-3-5");
  });
});
