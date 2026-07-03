// Runware tests cover stream plugin behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { wrapRunwareProviderStream } from "./stream.js";

function capturePayload(params: {
  initialPayload: Record<string, unknown>;
  maxTokens?: number;
  provider?: string;
}): Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    const payload = { ...params.initialPayload };
    options?.onPayload?.(payload, _model);
    captured = payload;
    return {} as ReturnType<StreamFn>;
  };

  const model = {
    api: "openai-completions",
    provider: params.provider ?? "runware",
    id: "deepseek-v4-flash",
    maxTokens: params.maxTokens ?? 65536,
  } as Model<"openai-completions">;

  const wrapped = wrapRunwareProviderStream({
    provider: params.provider ?? "runware",
    modelId: model.id,
    model,
    streamFn: baseStreamFn,
  });
  expect(wrapped).toBeDefined();
  void wrapped!(model, { messages: [] } as Context, {});

  return captured;
}

describe("wrapRunwareProviderStream", () => {
  it("returns undefined for non-Runware providers", () => {
    const wrapped = wrapRunwareProviderStream({
      provider: "openai",
      modelId: "gpt-5",
      streamFn: undefined,
    });
    expect(wrapped).toBeUndefined();
  });

  it("injects the model's max_tokens when the request omits it", () => {
    const payload = capturePayload({ initialPayload: {}, maxTokens: 65536 });
    expect(payload.max_tokens).toBe(65536);
  });

  it("clamps an outgoing max_tokens that exceeds the model's cap", () => {
    const payload = capturePayload({
      initialPayload: { max_tokens: 999_999 },
      maxTokens: 65536,
    });
    expect(payload.max_tokens).toBe(65536);
  });

  it("leaves a within-cap max_tokens untouched", () => {
    const payload = capturePayload({
      initialPayload: { max_tokens: 1024 },
      maxTokens: 65536,
    });
    expect(payload.max_tokens).toBe(1024);
  });

  it("patches a tool with empty properties", () => {
    const payload = capturePayload({
      initialPayload: {
        tools: [
          {
            type: "function",
            function: { name: "ping", parameters: { type: "object", properties: {} } },
          },
        ],
      },
    });
    expect(payload.tools).toEqual([
      {
        type: "function",
        function: {
          name: "ping",
          parameters: {
            type: "object",
            properties: {
              _unused: { type: "string", description: "Unused. This tool takes no parameters." },
            },
          },
        },
      },
    ]);
  });

  it("leaves a tool with real parameters unchanged", () => {
    const parameters = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    const payload = capturePayload({
      initialPayload: {
        tools: [{ type: "function", function: { name: "search", parameters } }],
      },
    });
    expect((payload.tools as never[])[0]).toEqual({
      type: "function",
      function: { name: "search", parameters },
    });
  });

  it("re-patches an empty tool schema even after another sanitizer already ran", () => {
    // Simulates a family-specific sanitizer (e.g. Kimi/Moonshot tool-call handling)
    // running before this wrapper in the stream chain; the Runware fix must still apply.
    let captured: Record<string, unknown> = {};
    const innerStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        tools: [
          {
            type: "function",
            function: { name: "ping", parameters: { type: "object", properties: {} } },
          },
        ],
      };
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };
    const model = {
      api: "openai-completions",
      provider: "runware",
      id: "moonshotai-kimi-k2-6",
      maxTokens: 65536,
    } as Model<"openai-completions">;

    const wrapped = wrapRunwareProviderStream({
      provider: "runware",
      modelId: model.id,
      model,
      streamFn: innerStreamFn,
    });
    void wrapped!(model, { messages: [] } as Context, {});

    const tools = captured.tools as Array<{
      function: { parameters: { properties: Record<string, unknown> } };
    }>;
    expect(Object.keys(tools[0].function.parameters.properties)).toEqual(["_unused"]);
  });
});
