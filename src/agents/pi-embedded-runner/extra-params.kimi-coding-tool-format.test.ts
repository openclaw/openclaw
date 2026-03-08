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

/**
 * Run an agent streamFn and capture the payload after applyExtraParamsToAgent.
 * The payload object simulates what pi-ai's buildParams produces for
 * anthropic-messages before sending to the Kimi Coding endpoint.
 */
function capturePayloadAfterExtraParams(params: {
  provider: string;
  modelId: string;
  model: Model<"anthropic-messages">;
  payload: Record<string, unknown>;
  cfg?: Parameters<typeof applyExtraParamsToAgent>[1];
  options?: SimpleStreamOptions;
}): Record<string, unknown> {
  const payload = params.payload;
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload);
    return {} as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(agent, params.cfg, params.provider, params.modelId);

  const context: Context = { messages: [] };
  void agent.streamFn?.(params.model, context, params.options ?? {});

  return payload;
}

describe("extra-params: kimi-coding tool format (#39882)", () => {
  const kimiModel: Model<"anthropic-messages"> = {
    api: "anthropic-messages",
    provider: "kimi-coding",
    id: "k2p5",
  } as Model<"anthropic-messages">;

  it("does not transform Anthropic-format tools to OpenAI format", () => {
    // Simulate a payload with tools in Anthropic format (name + input_schema)
    // as pi-ai's anthropic provider would produce.
    const anthropicTools = [
      {
        name: "Read",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "The file path" },
          },
          required: ["file_path"],
        },
      },
      {
        name: "Bash",
        description: "Run a bash command",
        input_schema: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command" },
          },
          required: ["command"],
        },
      },
    ];

    const payload = capturePayloadAfterExtraParams({
      provider: "kimi-coding",
      modelId: "k2p5",
      model: kimiModel,
      payload: {
        model: "k2p5",
        messages: [],
        tools: anthropicTools,
      },
    });

    // Tools must remain in native Anthropic format (name + input_schema).
    // They must NOT be converted to OpenAI format (type: "function" + function.parameters).
    const tools = payload.tools as Record<string, unknown>[];
    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      // Anthropic format assertions
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("input_schema");

      // Must NOT have OpenAI format fields
      expect(tool).not.toHaveProperty("type");
      expect(tool).not.toHaveProperty("function");
    }
  });

  it("does not inject tool_stream or other tool-modifying params for kimi-coding", () => {
    const payload = capturePayloadAfterExtraParams({
      provider: "kimi-coding",
      modelId: "k2p5",
      model: kimiModel,
      payload: {
        model: "k2p5",
        messages: [],
      },
    });

    expect(payload).not.toHaveProperty("tool_stream");
  });

  it("preserves tool_choice when set in payload", () => {
    const payload = capturePayloadAfterExtraParams({
      provider: "kimi-coding",
      modelId: "k2p5",
      model: kimiModel,
      payload: {
        model: "k2p5",
        messages: [],
        tool_choice: { type: "auto" },
      },
    });

    // kimi-coding should not override tool_choice
    // (only moonshot provider normalizes tool_choice for thinking compat)
    expect(payload.tool_choice).toEqual({ type: "auto" });
  });
});
