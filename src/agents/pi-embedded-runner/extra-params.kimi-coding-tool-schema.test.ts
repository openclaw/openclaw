import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

type ToolPayloadCase = {
  applyProvider: string;
  applyModelId: string;
  model: Model<"anthropic-messages">;
};

function runToolPayloadCase(params: ToolPayloadCase): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    tools: [
      {
        name: "read",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: {
            filePath: { type: "string" },
          },
          required: ["filePath"],
        },
      },
      {
        type: "function",
        name: "message",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
        },
      },
    ],
    tool_choice: {
      type: "tool",
      name: "read",
    },
  };

  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload);
    return {} as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(agent, undefined, params.applyProvider, params.applyModelId);

  const context: Context = { messages: [] };
  void agent.streamFn?.(params.model, context, {});

  return payload;
}

describe("extra-params: Kimi anthropic tool schema wrapper", () => {
  it("normalizes tools for api.kimi.com/v1 anthropic endpoints", () => {
    const payload = runToolPayloadCase({
      applyProvider: "custom",
      applyModelId: "k2p5",
      model: {
        api: "anthropic-messages",
        provider: "custom",
        id: "k2p5",
        baseUrl: "https://api.kimi.com/v1",
      } as Model<"anthropic-messages">,
    });

    expect(payload.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string" },
            },
            required: ["filePath"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "message",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string" },
            },
            required: ["text"],
          },
        },
      },
    ]);
    expect(payload.tool_choice).toEqual({
      type: "function",
      function: { name: "read" },
    });
  });

  it("does not normalize tools for non-kimi anthropic endpoints", () => {
    const payload = runToolPayloadCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4",
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4",
        baseUrl: "https://api.anthropic.com",
      } as Model<"anthropic-messages">,
    });

    const tools = payload.tools as Array<Record<string, unknown>>;
    expect(tools[0]?.name).toBe("read");
    expect(tools[0]?.function).toBeUndefined();
    expect(payload.tool_choice).toEqual({
      type: "tool",
      name: "read",
    });
  });
});
