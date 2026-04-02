import { describe, expect, it, vi } from "vitest";

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveProviderCacheTtlEligibility: (params: {
    context: { provider: string; modelId: string };
  }) => {
    if (params.context.provider === "anthropic") {
      return true;
    }
    if (params.context.provider === "moonshot" || params.context.provider === "zai") {
      return true;
    }
    if (params.context.provider === "openrouter") {
      return ["anthropic/", "moonshot/", "moonshotai/", "zai/"].some((prefix) =>
        params.context.modelId.startsWith(prefix),
      );
    }
    return undefined;
  },
}));

import { isCacheTtlEligibleProvider, resolveCacheTtlMs } from "./cache-ttl.js";
import { log } from "./logger.js";

describe("isCacheTtlEligibleProvider", () => {
  it("allows anthropic", () => {
    expect(isCacheTtlEligibleProvider("anthropic", "claude-sonnet-4-20250514")).toBe(true);
  });

  it("uses provider-specific native eligibility rules", () => {
    expect(isCacheTtlEligibleProvider("moonshot", "kimi-k2.5")).toBe(false);
    expect(isCacheTtlEligibleProvider("zai", "glm-5")).toBe(true);
  });

  it("normalizes native eligibility rules case-insensitively", () => {
    expect(isCacheTtlEligibleProvider("Moonshot", "Kimi-K2.5")).toBe(false);
    expect(isCacheTtlEligibleProvider("ZAI", "GLM-5")).toBe(true);
  });

  it("allows openrouter cache-ttl models", () => {
    expect(isCacheTtlEligibleProvider("openrouter", "anthropic/claude-sonnet-4")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "moonshotai/kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "moonshot/kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "zai/glm-5")).toBe(true);
  });

  it("rejects unsupported providers and models", () => {
    expect(isCacheTtlEligibleProvider("openai", "gpt-4o")).toBe(false);
    expect(isCacheTtlEligibleProvider("openrouter", "openai/gpt-4o")).toBe(false);
  });
});

describe("resolveCacheTtlMs", () => {
  it("uses sessionCacheTtl when configured", () => {
    expect(
      resolveCacheTtlMs({
        config: {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-sonnet-4": {
                  params: {
                    sessionCacheTtl: "45m",
                    timeBasedContextCompact: "compact",
                  },
                },
              },
            },
          },
        },
        provider: "anthropic",
        modelId: "claude-sonnet-4",
      }),
    ).toBe(45 * 60_000);
  });

  it("returns null when sessionCacheTtl is unset", () => {
    expect(
      resolveCacheTtlMs({
        config: {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-haiku-4": {
                  params: { cacheRetention: "long" },
                },
              },
            },
          },
        },
        provider: "anthropic",
        modelId: "claude-haiku-4",
      }),
    ).toBeNull();
  });

  it("returns null when timeBasedContextCompact is unset", () => {
    expect(
      resolveCacheTtlMs({
        config: {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-haiku-4": {
                  params: { sessionCacheTtl: "1h" },
                },
              },
            },
          },
        },
        provider: "anthropic",
        modelId: "claude-haiku-4",
      }),
    ).toBeNull();
  });

  it("still uses sessionCacheTtl when cacheRetention disables model caching", () => {
    expect(
      resolveCacheTtlMs({
        config: {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-sonnet-4": {
                  params: {
                    cacheRetention: "none",
                    sessionCacheTtl: "1h",
                    timeBasedContextCompact: "reset",
                  },
                },
              },
            },
          },
        },
        provider: "anthropic",
        modelId: "claude-sonnet-4",
      }),
    ).toBe(60 * 60_000);
  });

  it("warns when sessionCacheTtl exceeds an explicit model cache ttl", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    expect(
      resolveCacheTtlMs({
        config: {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-opus-4": {
                  params: {
                    cacheRetention: "short",
                    sessionCacheTtl: "1h",
                    timeBasedContextCompact: "reset",
                  },
                },
              },
            },
          },
        },
        provider: "anthropic",
        modelId: "claude-opus-4",
      }),
    ).toBe(60 * 60_000);

    expect(warnSpy).toHaveBeenCalledWith("sessionCacheTtl exceeds explicit model cache ttl", {
      provider: "anthropic",
      modelId: "claude-opus-4",
      sessionCacheTtlMs: 60 * 60_000,
      explicitModelCacheTtlMs: 5 * 60_000,
    });
    warnSpy.mockRestore();
  });
});
