import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

// Mock streamSimple for testing
vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: vi.fn(() => ({
    push: vi.fn(),
    result: vi.fn(),
  })),
}));

type ToolStreamCase = {
  applyProvider: string;
  applyModelId: string;
  model: Model<"openai-completions">;
  cfg?: Parameters<typeof applyExtraParamsToAgent>[1];
  options?: SimpleStreamOptions;
};

function runToolStreamCase(params: ToolStreamCase) {
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

describe("extra-params: Z.AI tool_stream support", () => {
  it("injects tool_stream=true for zai provider by default", () => {
    const payload = runToolStreamCase({
      applyProvider: "zai",
      applyModelId: "glm-5",
      model: {
        api: "openai-completions",
        provider: "zai",
        id: "glm-5",
      } as Model<"openai-completions">,
    });

    expect(payload.tool_stream).toBe(true);
  });

  it("does not inject tool_stream for non-zai providers", () => {
    const payload = runToolStreamCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5",
      } as Model<"openai-completions">,
    });

    expect(payload).not.toHaveProperty("tool_stream");
  });

  it("allows disabling tool_stream via params", () => {
    const payload = runToolStreamCase({
      applyProvider: "zai",
      applyModelId: "glm-5",
      model: {
        api: "openai-completions",
        provider: "zai",
        id: "glm-5",
      } as Model<"openai-completions">,
      cfg: {
        agents: {
          defaults: {
            models: {
              "zai/glm-5": {
                params: {
                  tool_stream: false,
                },
              },
            },
          },
        },
      },
    });

    expect(payload).not.toHaveProperty("tool_stream");
  });
});
