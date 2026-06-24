import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
// Tests for wrapOllamaCompatNumCtx — verifies FIX #96441:
// OpenAI-compatible tool_calls.function.arguments must remain as JSON strings
// (not be normalized back to objects).
import { beforeEach, describe, expect, it, vi } from "vitest";

// Track every payload patcher that wrapOllamaCompatNumCtx registers.
const capturedPatchers: Array<(payload: Record<string, unknown>) => void> = [];

vi.mock("openclaw/plugin-sdk/provider-stream-shared", () => ({
  streamWithPayloadPatch: vi.fn(
    (
      _streamFn: unknown,
      _model: unknown,
      _context: unknown,
      _options: unknown,
      patcher: (payload: Record<string, unknown>) => void,
    ) => {
      capturedPatchers.push(patcher);
      return createAssistantMessageEventStream();
    },
  ),
}));

import { wrapOllamaCompatNumCtx } from "./stream.js";

describe("wrapOllamaCompatNumCtx — FIX #96441", () => {
  beforeEach(() => {
    capturedPatchers.length = 0;
  });

  it("injects num_ctx into payload options", async () => {
    const wrapped = wrapOllamaCompatNumCtx(undefined, 4096);
    await wrapped({} as any, { messages: [], systemPrompt: "" } as any);

    expect(capturedPatchers.length).toBe(1);
    const patcher = capturedPatchers[0];

    const payload: Record<string, unknown> = { options: {}, messages: [] };
    patcher(payload);

    expect((payload.options as Record<string, unknown>).num_ctx).toBe(4096);
  });

  it("preserves tool_calls[*].function.arguments as strings (FIX #96441)", async () => {
    const wrapped = wrapOllamaCompatNumCtx(undefined, 4096);
    await wrapped({} as any, { messages: [], systemPrompt: "" } as any);

    expect(capturedPatchers.length).toBe(1);
    const patcher = capturedPatchers[0];

    // Simulate the payload that openai-completions.ts produces:
    // arguments is a JSON string per the OpenAI API spec.
    const payload: Record<string, unknown> = {
      options: {},
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "config_get",
                arguments: '{"action":"config.get","path":"gateway.port"}',
              },
            },
          ],
        },
      ],
    };

    patcher(payload);

    // Read back the tool_calls and verify arguments stayed as a string.
    const messages = payload.messages as Array<Record<string, unknown>>;
    const toolCalls = messages[0].tool_calls as Array<Record<string, unknown>>;
    const fnSpec = toolCalls[0].function as Record<string, unknown>;

    expect(typeof fnSpec.arguments).toBe("string");
    expect(fnSpec.arguments).toBe('{"action":"config.get","path":"gateway.port"}');
  });

  it("preserves function_call.arguments as strings (legacy format)", async () => {
    const wrapped = wrapOllamaCompatNumCtx(undefined, 4096);
    await wrapped({} as any, { messages: [], systemPrompt: "" } as any);

    expect(capturedPatchers.length).toBe(1);
    const patcher = capturedPatchers[0];

    // Some older models use the legacy function_call format.
    const payload: Record<string, unknown> = {
      options: {},
      messages: [
        {
          role: "assistant",
          function_call: {
            name: "get_weather",
            arguments: '{"city":"London"}',
          },
        },
      ],
    };

    patcher(payload);

    const messages = payload.messages as Array<Record<string, unknown>>;
    const fnCall = messages[0].function_call as Record<string, unknown>;

    expect(typeof fnCall.arguments).toBe("string");
    expect(fnCall.arguments).toBe('{"city":"London"}');
  });

  it("handles messages without tool_calls or function_call gracefully", async () => {
    const wrapped = wrapOllamaCompatNumCtx(undefined, 4096);
    await wrapped({} as any, { messages: [], systemPrompt: "" } as any);

    expect(capturedPatchers.length).toBe(1);
    const patcher = capturedPatchers[0];

    // Payload with a plain user message — no tool-related fields.
    const payload: Record<string, unknown> = {
      options: {},
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ],
    };

    // Should not throw or modify anything.
    expect(() => patcher(payload)).not.toThrow();
    expect((payload.messages as Array<Record<string, unknown>>)[1].content).toBe("Hi there");
  });
});
