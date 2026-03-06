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
  options?: SimpleStreamOptions;
};

function runEffortCase(params: EffortCase) {
  const payload: Record<string, unknown> = { model: params.model.id, messages: [] };
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

describe("extra-params: effort override for Anthropic models", () => {
  it("injects output_config.effort when params.effort is set", () => {
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

  it("does not inject output_config.effort for non-anthropic API models", () => {
    const payload: Record<string, unknown> = { model: "gpt-5", messages: [] };
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      {
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
      "openai",
      "gpt-5",
    );

    const context: Context = { messages: [] };
    const model = {
      api: "openai-completions",
      provider: "openai",
      id: "gpt-5",
    } as Model<"openai-completions">;
    void agent.streamFn?.(model, context, {});

    expect(payload).not.toHaveProperty("output_config");
  });

  it("does not inject output_config.effort when no effort param is configured", () => {
    const payload = runEffortCase({
      applyProvider: "anthropic",
      applyModelId: "claude-opus-4-6",
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-opus-4-6",
      } as Model<"anthropic-messages">,
    });

    expect(payload).not.toHaveProperty("output_config");
  });

  it("preserves existing output_config fields when injecting effort", () => {
    const payload: Record<string, unknown> = {
      model: "claude-opus-4-6",
      messages: [],
      output_config: { existing_field: true },
    };
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: {
                  effort: "high",
                },
              },
            },
          },
        },
      },
      "anthropic",
      "claude-opus-4-6",
    );

    const context: Context = { messages: [] };
    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-opus-4-6",
    } as Model<"anthropic-messages">;
    void agent.streamFn?.(model, context, {});

    expect(payload.output_config).toEqual({ existing_field: true, effort: "high" });
  });
});
