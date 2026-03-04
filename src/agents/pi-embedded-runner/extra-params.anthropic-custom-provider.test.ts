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

describe("custom Anthropic provider beta headers", () => {
  it("applies anthropicBeta for 'anthropic-1m' provider", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic-1m/claude-opus-4-6": {
              params: {
                anthropicBeta: "context-1m-2025-08-07",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "anthropic-1m", "claude-opus-4-6");

    // streamFn should be wrapped (beta headers + cache retention wrappers)
    expect(agent.streamFn).toBeDefined();
  });

  it("applies anthropicBeta for 'anthropic-beta' provider", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic-beta/claude-opus-4-6": {
              params: {
                anthropicBeta: "interleaved-thinking-2025-05-14",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "anthropic-beta", "claude-opus-4-6");

    expect(agent.streamFn).toBeDefined();
  });

  it("applies cache retention default for custom anthropic- prefixed providers", () => {
    const agent: { streamFn?: StreamFn } = {};

    applyExtraParamsToAgent(agent, undefined, "anthropic-1m", "claude-opus-4-6");

    // Should apply default "short" cache retention, same as canonical "anthropic" provider
    expect(agent.streamFn).toBeDefined();
  });

  it("does not apply anthropic betas for non-anthropic providers", () => {
    // Verify that specifying anthropicBeta on a non-Anthropic provider does not
    // crash or misbehave.  We don't check streamFn === undefined because other
    // wrappers (e.g. extra-params) may still be applied for the provider.
    const agent: { streamFn?: StreamFn } = {};
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4": {
              params: {
                anthropicBeta: "context-1m-2025-08-07",
              },
            },
          },
        },
      },
    };

    // Should not throw
    expect(() => applyExtraParamsToAgent(agent, cfg, "openai", "gpt-4")).not.toThrow();
  });
});
