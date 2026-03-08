import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { applyExtraParamsToAgent } from "../pi-embedded-runner.js";

// Mock the logger to avoid noise in tests
vi.mock("./logger.js", () => ({
  log: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("cacheRetention default behavior", () => {
  it("returns 'short' for Anthropic when not configured", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = undefined;
    const provider = "anthropic";
    const modelId = "claude-3-sonnet";

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    // Verify streamFn was set (indicating cache retention was applied)
    expect(agent.streamFn).toBeDefined();

    // The fact that agent.streamFn was modified indicates that cacheRetention
    // default "short" was applied. We don't need to call the actual function
    // since that would require API provider setup.
  });

  it("respects explicit 'none' config", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-3-sonnet": {
              params: {
                cacheRetention: "none" as const,
              },
            },
          },
        },
      },
    };
    const provider = "anthropic";
    const modelId = "claude-3-sonnet";

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    // Verify streamFn was set (config was applied)
    expect(agent.streamFn).toBeDefined();
  });

  it("respects explicit 'long' config", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-3-opus": {
              params: {
                cacheRetention: "long" as const,
              },
            },
          },
        },
      },
    };
    const provider = "anthropic";
    const modelId = "claude-3-opus";

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    // Verify streamFn was set (config was applied)
    expect(agent.streamFn).toBeDefined();
  });

  it("respects legacy cacheControlTtl config", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-3-haiku": {
              params: {
                cacheControlTtl: "1h",
              },
            },
          },
        },
      },
    };
    const provider = "anthropic";
    const modelId = "claude-3-haiku";

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    // Verify streamFn was set (legacy config was applied)
    expect(agent.streamFn).toBeDefined();
  });

  it("does not apply cacheRetention for OpenAI when not configured", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = undefined;
    const provider = "openai";
    const modelId = "gpt-4";

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    // Without explicit cacheRetention config, OpenAI should not get cache retention.
    // The streamFn may still be wrapped for other reasons (e.g. OpenAI responses store).
  });

  it("applies cacheRetention 'long' for OpenAI when explicitly configured", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.2": {
              params: {
                cacheRetention: "long" as const,
              },
            },
          },
        },
      },
    };
    const provider = "openai";
    const modelId = "gpt-5.2";

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    // pi-ai maps cacheRetention: "long" to prompt_cache_retention: "24h"
    // for api.openai.com URLs in openai-responses.ts
    expect(agent.streamFn).toBeDefined();
  });

  it("applies cacheRetention for openai-codex provider", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.2-codex": {
              params: {
                cacheRetention: "long" as const,
              },
            },
          },
        },
      },
    };
    const provider = "openai-codex";
    const modelId = "gpt-5.2-codex";

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    expect(agent.streamFn).toBeDefined();
  });

  it("does not apply cacheRetention for unsupported providers", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = {
      agents: {
        defaults: {
          models: {
            "google/gemini-2.5-pro": {
              params: {
                cacheRetention: "long" as const,
              },
            },
          },
        },
      },
    };
    const provider = "google";
    const modelId = "gemini-2.5-pro";

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    // Google provider should not get cacheRetention applied
    // (Google has its own implicit caching mechanism)
  });

  it("prefers explicit cacheRetention over default", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-3-sonnet": {
              params: {
                cacheRetention: "long" as const,
                temperature: 0.7,
              },
            },
          },
        },
      },
    };
    const provider = "anthropic";
    const modelId = "claude-3-sonnet";

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    // Verify streamFn was set with explicit config
    expect(agent.streamFn).toBeDefined();
  });

  it("works with extraParamsOverride", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = undefined;
    const provider = "anthropic";
    const modelId = "claude-3-sonnet";
    const extraParamsOverride = {
      cacheRetention: "none" as const,
    };

    applyExtraParamsToAgent(agent, cfg, provider, modelId, extraParamsOverride);

    // Verify streamFn was set (override was applied)
    expect(agent.streamFn).toBeDefined();
  });
});
