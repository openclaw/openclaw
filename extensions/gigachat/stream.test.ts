import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { normalizeGigachatToolPayload, wrapGigachatProviderStream } from "./stream.js";

function capturePayload(payload: Record<string, unknown>) {
  const payloads: Record<string, unknown>[] = [];
  const baseStreamFn: StreamFn = (model, _context, options) => {
    options?.onPayload?.(payload, model);
    payloads.push(structuredClone(payload));
    return createAssistantMessageEventStream();
  };
  return { baseStreamFn, payloads };
}

describe("GigaChat tool payload adapter", () => {
  it("maps OpenAI tools and tool_choice to GigaChat functions", () => {
    const payload: Record<string, unknown> = {
      tools: [
        {
          type: "function",
          function: {
            name: "weather_forecast",
            description: "Returns weather.",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" },
              },
              required: ["location"],
            },
            strict: true,
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "weather_forecast" },
      },
      parallel_tool_calls: true,
    };

    normalizeGigachatToolPayload(payload);

    expect(payload).toEqual({
      functions: [
        {
          name: "weather_forecast",
          description: "Returns weather.",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string" },
            },
            required: ["location"],
          },
        },
      ],
      function_call: { name: "weather_forecast" },
    });
  });

  it("maps required tool_choice to auto because GigaChat has no required mode", () => {
    const payload: Record<string, unknown> = {
      tools: [{ type: "function", function: { name: "read_file", parameters: {} } }],
      tool_choice: "required",
    };

    normalizeGigachatToolPayload(payload);

    expect(payload.function_call).toBe("auto");
  });

  it("maps replayed tool call messages to GigaChat function messages", () => {
    const payload: Record<string, unknown> = {
      messages: [
        {
          role: "assistant",
          content: "calling tool",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "weather_forecast",
                arguments: '{"location":"Moscow"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "sunny",
        },
        {
          role: "user",
          content: [{ type: "text", text: "what should I wear?" }],
          unsupported: true,
        },
      ],
    };

    normalizeGigachatToolPayload(payload);

    expect(payload.messages).toEqual([
      {
        role: "assistant",
        content: "calling tool",
        function_call: {
          name: "weather_forecast",
          arguments: { location: "Moscow" },
        },
      },
      {
        role: "function",
        name: "weather_forecast",
        content: JSON.stringify({ result: "sunny" }),
      },
      {
        role: "user",
        content: [{ type: "text", text: "what should I wear?" }],
      },
    ]);
  });

  it("wraps stream payloads before they reach the transport", () => {
    const payload = {
      tools: [{ type: "function", function: { name: "read_file", parameters: {} } }],
      tool_choice: "auto",
    };
    const { baseStreamFn, payloads } = capturePayload(payload);
    const wrapped = wrapGigachatProviderStream(baseStreamFn);

    void wrapped(
      {
        api: "openai-completions",
        provider: "gigachat",
        id: "GigaChat-2",
      } as never,
      { messages: [] },
      {},
    );

    expect(payloads[0]).toEqual({
      functions: [{ name: "read_file", parameters: {} }],
      function_call: "auto",
    });
  });
});
