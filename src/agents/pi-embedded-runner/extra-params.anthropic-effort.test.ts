import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: vi.fn(() => ({
    push: vi.fn(),
    result: vi.fn(),
  })),
}));

type EffortCase = {
  applyProvider: string;
  applyModelId: string;
  model: Model<"anthropic-messages">;
  cfg?: Parameters<typeof applyExtraParamsToAgent>[1];
  /** Pre-populated payload fields to simulate pi-ai SDK output */
  payloadOverrides?: Record<string, unknown>;
  options?: SimpleStreamOptions;
};

function runEffortCase(params: EffortCase) {
  const payload: Record<string, unknown> = {
    model: params.model.id,
    messages: [],
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    ...params.payloadOverrides,
  };

  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload);
    return {} as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(agent, params.cfg, params.applyProvider, params.applyModelId);

  const context: Context = { messages: [] };
  void agent.streamFn?.(params.model, context, params.options ?? {});

  return payload;
}

describe("extra-params: Anthropic effort override", () => {
  it("overrides output_config.effort when effort is configured", () => {
    const payload = runEffortCase({
      applyProvider: "anthropic",
      applyModelId: "claude-opus-4-6",
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-opus-4-6",
      } as Model<"anthropic-messages">,
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: {
                  thinking: "adaptive",
                  effort: "max",
                },
              },
            },
          },
        },
      },
    });

    expect((payload.output_config as Record<string, unknown>).effort).toBe("max");
  });

  it("overrides effort to high for sonnet", () => {
    const payload = runEffortCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-6",
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-6",
      } as Model<"anthropic-messages">,
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {
                params: {
                  effort: "high",
                },
              },
            },
          },
        },
      },
    });

    expect((payload.output_config as Record<string, unknown>).effort).toBe("high");
  });

  it("does not apply effort override for non-Anthropic providers", () => {
    const payload = runEffortCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "anthropic-messages" as never,
        provider: "openai",
        id: "gpt-5",
      } as Model<"anthropic-messages">,
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5": {
                params: {
                  effort: "max",
                },
              },
            },
          },
        },
      },
    });

    // Should remain "medium" (the payload default), not overridden
    expect((payload.output_config as Record<string, unknown>).effort).toBe("medium");
  });

  it("ignores invalid effort values", () => {
    const payload = runEffortCase({
      applyProvider: "anthropic",
      applyModelId: "claude-opus-4-6",
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-opus-4-6",
      } as Model<"anthropic-messages">,
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: {
                  effort: "ultra",
                },
              },
            },
          },
        },
      },
    });

    // Should remain "medium" since "ultra" is not a valid effort value
    expect((payload.output_config as Record<string, unknown>).effort).toBe("medium");
  });

  it("creates output_config when payload has thinking but no output_config", () => {
    const payload = runEffortCase({
      applyProvider: "anthropic",
      applyModelId: "claude-opus-4-6",
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-opus-4-6",
      } as Model<"anthropic-messages">,
      payloadOverrides: {
        thinking: { type: "adaptive" },
        output_config: undefined,
      },
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: {
                  effort: "max",
                },
              },
            },
          },
        },
      },
    });

    expect(payload.output_config).toEqual({ effort: "max" });
  });

  it("does not override effort when thinking is not set in payload", () => {
    const payload = runEffortCase({
      applyProvider: "anthropic",
      applyModelId: "claude-opus-4-6",
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-opus-4-6",
      } as Model<"anthropic-messages">,
      payloadOverrides: {
        thinking: undefined,
        output_config: { effort: "medium" },
      },
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: {
                  effort: "max",
                },
              },
            },
          },
        },
      },
    });

    // Should remain "medium" because thinking is not set
    expect((payload.output_config as Record<string, unknown>).effort).toBe("medium");
  });

  it("applies effort override for amazon-bedrock provider", () => {
    const payload = runEffortCase({
      applyProvider: "amazon-bedrock",
      applyModelId: "anthropic.claude-opus-4-6",
      model: {
        api: "anthropic-messages",
        provider: "amazon-bedrock",
        id: "anthropic.claude-opus-4-6",
      } as Model<"anthropic-messages">,
      cfg: {
        agents: {
          defaults: {
            models: {
              "amazon-bedrock/anthropic.claude-opus-4-6": {
                params: {
                  effort: "high",
                },
              },
            },
          },
        },
      },
    });

    expect((payload.output_config as Record<string, unknown>).effort).toBe("high");
  });
});
