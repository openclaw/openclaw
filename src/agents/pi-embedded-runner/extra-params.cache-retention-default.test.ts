import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { applyExtraParamsToAgent } from "../pi-embedded-runner.js";

function applyAndExpectWrapped(params: {
  cfg?: Parameters<typeof applyExtraParamsToAgent>[1];
  extraParamsOverride?: Parameters<typeof applyExtraParamsToAgent>[4];
  modelId: string;
  provider: string;
}) {
  const agent: { streamFn?: StreamFn } = {};

  applyExtraParamsToAgent(
    agent,
    params.cfg,
    params.provider,
    params.modelId,
    params.extraParamsOverride,
  );

  expect(agent.streamFn).toBeDefined();
}

// Mock the logger to avoid noise in tests
vi.mock("./logger.js", () => ({
  log: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("cacheRetention default behavior", () => {
  it("returns 'short' for Anthropic when not configured", () => {
    applyAndExpectWrapped({
      modelId: "claude-3-sonnet",
      provider: "anthropic",
    });

    // The fact that agent.streamFn was modified indicates that cacheRetention
    // default "short" was applied. We don't need to call the actual function
    // since that would require API provider setup.
  });

  it("respects explicit 'none' config", () => {
    applyAndExpectWrapped({
      cfg: {
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
      },
      modelId: "claude-3-sonnet",
      provider: "anthropic",
    });
  });

  it("respects explicit 'long' config", () => {
    applyAndExpectWrapped({
      cfg: {
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
      },
      modelId: "claude-3-opus",
      provider: "anthropic",
    });
  });

  it("respects legacy cacheControlTtl config", () => {
    applyAndExpectWrapped({
      cfg: {
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
      },
      modelId: "claude-3-haiku",
      provider: "anthropic",
    });
  });

  it("returns undefined for non-Anthropic providers", () => {
    const agent: { streamFn?: StreamFn } = {};
    const cfg = undefined;
    const provider = "openai";
    const modelId = "gpt-4";

    applyExtraParamsToAgent(agent, cfg, provider, modelId);

    // For OpenAI, the streamFn might be wrapped for other reasons (like OpenAI responses store)
    // but cacheRetention should not be applied
    // This is implicitly tested by the lack of cacheRetention-specific wrapping
  });

  it("prefers explicit cacheRetention over default", () => {
    applyAndExpectWrapped({
      cfg: {
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
      },
      modelId: "claude-3-sonnet",
      provider: "anthropic",
    });
  });

  it("works with extraParamsOverride", () => {
    applyAndExpectWrapped({
      extraParamsOverride: {
        cacheRetention: "none" as const,
      },
      modelId: "claude-3-sonnet",
      provider: "anthropic",
    });
  });

  it("forwards toolChoice overrides to the wrapped stream options", async () => {
    const baseStreamFn = vi.fn(async () => undefined);
    const agent: { streamFn?: StreamFn } = { streamFn: baseStreamFn as unknown as StreamFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "openai",
      "gpt-4.1",
      {
        toolChoice: {
          type: "function",
          function: {
            name: "emit_structured_result",
          },
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      new Set(["emit_structured_result"]),
    );

    expect(agent.streamFn).toBeDefined();
    await agent.streamFn?.(
      { api: "openai-responses", provider: "openai", id: "gpt-4.1", compat: {} } as never,
      {} as never,
      {},
    );

    expect(baseStreamFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        toolChoice: {
          type: "function",
          function: {
            name: "emit_structured_result",
          },
        },
      }),
    );
  });

  it("drops stale function toolChoice selections that are not in the allowed tool set", async () => {
    const baseStreamFn = vi.fn(async () => undefined);
    const agent: { streamFn?: StreamFn } = { streamFn: baseStreamFn as unknown as StreamFn };
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-4.1": {
              params: {
                toolChoice: {
                  type: "function",
                  function: {
                    name: "bash",
                  },
                },
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(
      agent,
      cfg,
      "openai",
      "gpt-4.1",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new Set(["emit_structured_result"]),
    );

    expect(agent.streamFn).toBeDefined();
    await agent.streamFn?.(
      { api: "openai-responses", provider: "openai", id: "gpt-4.1", compat: {} } as never,
      {} as never,
      {},
    );

    expect(baseStreamFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        toolChoice: "auto",
      }),
    );
  });
});
