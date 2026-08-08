// Covers the two exported context-window resolvers: the Anthropic fixed-window
// gate (provider/model arms + the Claude-CLI 1M opt-in) and the cache/config
// token resolver (configured window, override capping, unscoped lookup).
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveAnthropicFixedContextWindow,
  resolveContextTokensForModelFromCache,
} from "./context-resolution.js";

const ONE_M = 1_000_000;

describe("resolveAnthropicFixedContextWindow", () => {
  // Each row pins a distinct contract arm: provider gate, per-family windows,
  // the mythos direct-API restriction, and the Claude-CLI 1M opt-in rules.
  const cases: Array<{
    name: string;
    provider: string;
    model: string;
    options?: { claudeCli1M?: boolean };
    expected: number | undefined;
  }> = [
    {
      name: "non-Anthropic provider is not gated here",
      provider: "openai",
      model: "gpt-5.6",
      expected: undefined,
    },
    {
      name: "the provider gate wins even for a 1M-capable Claude id",
      provider: "openai",
      model: "claude-opus-5",
      expected: undefined,
    },
    {
      name: "anthropic Opus 4.x reports 1M",
      provider: "anthropic",
      model: "claude-opus-4-6",
      expected: ONE_M,
    },
    {
      name: "anthropic-vertex reports its 1M window",
      provider: "anthropic-vertex",
      model: "claude-opus-4-7",
      expected: ONE_M,
    },
    {
      name: "a non-1M Claude model stays uncapped",
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      expected: undefined,
    },
    {
      name: "Fable 5 is 1M even on Claude CLI without [1m]",
      provider: "claude-cli",
      model: "claude-fable-5",
      expected: ONE_M,
    },
    {
      name: "Opus 5 is natively 1M on Claude CLI",
      provider: "claude-cli",
      model: "claude-opus-5",
      expected: ONE_M,
    },
    {
      name: "the Opus 5 alias resolves to 1M",
      provider: "anthropic",
      model: "opus-5",
      expected: ONE_M,
    },
    {
      name: "Sonnet 5 reports 1M",
      provider: "anthropic",
      model: "claude-sonnet-5",
      expected: ONE_M,
    },
    {
      name: "Mythos 5 is 1M on the direct API",
      provider: "anthropic",
      model: "claude-mythos-5",
      expected: ONE_M,
    },
    {
      name: "Mythos 5 is direct-API only, not on Claude CLI",
      provider: "claude-cli",
      model: "claude-mythos-5",
      expected: undefined,
    },
    {
      name: "Claude CLI without [1m] or opt-in keeps its discovered window",
      provider: "claude-cli",
      model: "claude-opus-4-6",
      expected: undefined,
    },
    {
      name: "the [1m] model suffix unlocks 1M on Claude CLI",
      provider: "claude-cli",
      model: "claude-opus-4-6[1m]",
      expected: ONE_M,
    },
    {
      name: "the claudeCli1M opt-in unlocks 1M on Claude CLI",
      provider: "claude-cli",
      model: "claude-opus-4-6",
      options: { claudeCli1M: true },
      expected: ONE_M,
    },
  ];

  for (const { name, provider, model, options, expected } of cases) {
    it(name, () => {
      expect(resolveAnthropicFixedContextWindow(provider, model, options)).toBe(expected);
    });
  }
});

describe("resolveContextTokensForModelFromCache", () => {
  // Injected lookups keep the process-local discovery cache out of the test so
  // only the resolver's config/override branches are exercised.
  const noCache = () => undefined;

  function configWithModel(entry: {
    id: string;
    contextTokens?: number;
    contextWindow?: number;
  }): OpenClawConfig {
    return {
      models: { providers: { openai: { models: [entry] } } },
    } as unknown as OpenClawConfig;
  }

  it("returns a configured provider contextTokens value", () => {
    const result = resolveContextTokensForModelFromCache(
      {
        cfg: configWithModel({ id: "gpt-5", contextTokens: 500_000 }),
        provider: "openai",
        model: "gpt-5",
      },
      noCache,
      noCache,
    );
    expect(result).toBe(500_000);
  });

  it("caps the configured contextTokens with a smaller override", () => {
    const result = resolveContextTokensForModelFromCache(
      {
        cfg: configWithModel({ id: "gpt-5", contextTokens: 500_000 }),
        provider: "openai",
        model: "gpt-5",
        contextTokensOverride: 200_000,
      },
      noCache,
      noCache,
    );
    expect(result).toBe(200_000);
  });

  it("returns a configured contextWindow value when no cap applies", () => {
    const result = resolveContextTokensForModelFromCache(
      {
        cfg: configWithModel({ id: "gpt-5", contextWindow: 400_000 }),
        provider: "openai",
        model: "gpt-5",
      },
      noCache,
      noCache,
    );
    expect(result).toBe(400_000);
  });

  it("skips the unscoped model lookup when allowUnscopedModelLookup is false", () => {
    // With the flag off the resolver must not consult the raw discovery key, so
    // the lookup that would otherwise return 999_000 is never reached.
    const result = resolveContextTokensForModelFromCache(
      {
        provider: "openai",
        model: "gpt-5",
        allowUnscopedModelLookup: false,
        fallbackContextTokens: 128_000,
      },
      (modelId) => (modelId === "gpt-5" ? 999_000 : undefined),
      noCache,
    );
    expect(result).toBe(128_000);
  });

  it("uses the raw discovery key for a model-only (provider-less) resolution", () => {
    const result = resolveContextTokensForModelFromCache(
      { model: "gpt-5" },
      (modelId) => (modelId === "gpt-5" ? 777_000 : undefined),
      noCache,
    );
    expect(result).toBe(777_000);
  });

  it("prefers the override over the fallback when nothing is discovered", () => {
    const result = resolveContextTokensForModelFromCache(
      { model: "unknown-model", contextTokensOverride: 42_000, fallbackContextTokens: 64_000 },
      noCache,
      noCache,
    );
    expect(result).toBe(42_000);
  });

  it("falls back to fallbackContextTokens when nothing else resolves", () => {
    const result = resolveContextTokensForModelFromCache(
      { model: "unknown-model", fallbackContextTokens: 64_000 },
      noCache,
      noCache,
    );
    expect(result).toBe(64_000);
  });
});
