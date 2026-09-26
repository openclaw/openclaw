import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  Context,
  Model,
  Tool,
  ToolResultMessage,
  UserMessage,
} from "../types.js";
import {
  buildGoogleInteractionsParams,
  resolveGoogleApiClientHeaders,
} from "./google-interactions-request.js";
import { makeModel } from "./google-shared.test-helpers.js";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(content: UserMessage["content"]): UserMessage {
  return { role: "user", content, timestamp: 0 };
}

function assistant(
  content: AssistantMessage["content"],
  identity?: Partial<Pick<AssistantMessage, "api" | "provider" | "model">>,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: identity?.api ?? "google-interactions",
    provider: identity?.provider ?? "google",
    model: identity?.model ?? "gemini-3-flash-preview",
    usage: zeroUsage,
    stopReason: "stop",
    timestamp: 0,
  };
}

function toolResult(
  toolCallId: string,
  toolName: string,
  content: ToolResultMessage["content"],
  isError = false,
): ToolResultMessage {
  return { role: "toolResult", toolCallId, toolName, content, isError, timestamp: 0 };
}

describe("buildGoogleInteractionsParams", () => {
  const model = {
    ...makeModel("gemini-3-flash-preview"),
    api: "google-interactions",
  } satisfies Model<"google-interactions">;

  it("converts basic messages to user_input and model_output steps", () => {
    const context: Context = {
      systemPrompt: "You are a helpful assistant.",
      messages: [
        user("Hello"),
        assistant([
          { type: "text", text: "Hi there!" },
          { type: "thinking", thinking: "internal thoughts" },
        ]),
        user("What is 2+2?"),
      ],
    };

    const params = buildGoogleInteractionsParams(model, context, {});

    expect(params.model).toBe("gemini-3-flash-preview");
    expect(params.system_instruction).toBe("You are a helpful assistant.");
    expect(params.store).toBe(false);
    expect(params.stream).toBe(true);

    expect(params.input).toEqual([
      {
        type: "user_input",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        type: "model_output",
        content: [{ type: "text", text: "Hi there!" }],
      },
      {
        type: "user_input",
        content: [{ type: "text", text: "What is 2+2?" }],
      },
    ]);
  });

  it("converts tools and tool calls/results", () => {
    const tools: Tool[] = [
      {
        name: "getWeather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    const context: Context = {
      messages: [
        user("Weather in Tokyo?"),
        assistant([
          {
            type: "toolCall",
            id: "call_123",
            name: "getWeather",
            arguments: { city: "Tokyo" },
          },
        ]),
        toolResult("call_123", "getWeather", [
          { type: "text", text: JSON.stringify({ temp: "20C" }) },
        ]),
      ],
      tools,
    };

    const params = buildGoogleInteractionsParams(model, context, {});

    expect(params.tools).toEqual([
      {
        type: "function",
        name: "getWeather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ]);

    expect(params.input).toEqual([
      {
        type: "user_input",
        content: [{ type: "text", text: "Weather in Tokyo?" }],
      },
      {
        type: "function_call",
        id: "call_123",
        name: "getWeather",
        arguments: { city: "Tokyo" },
      },
      {
        type: "function_result",
        call_id: "call_123",
        name: "getWeather",
        result: [{ type: "text", text: JSON.stringify({ temp: "20C" }) }],
        is_error: false,
      },
    ]);
  });

  it("preserves tool result failures in function_result steps", () => {
    const params = buildGoogleInteractionsParams(
      model,
      {
        messages: [
          user("Use a tool"),
          assistant([{ type: "toolCall", id: "call_failed", name: "lookup", arguments: {} }]),
          toolResult("call_failed", "lookup", [{ type: "text", text: "lookup failed" }], true),
        ],
      },
      {},
    );

    expect(params.input.at(-1)).toEqual({
      type: "function_result",
      call_id: "call_failed",
      name: "lookup",
      result: [{ type: "text", text: "lookup failed" }],
      is_error: true,
    });
  });

  it("recirculates thinking blocks with thought signatures as thought steps", () => {
    const context: Context = {
      messages: [
        user("Solve this problem"),
        assistant([
          {
            type: "thinking",
            thinking: "Let me break down the steps.",
            thinkingSignature: "sig_step_1234==",
          },
          { type: "text", text: "Here is the answer." },
        ]),
        user("Tell me more"),
      ],
    };

    const params = buildGoogleInteractionsParams(model, context, {});

    expect(params.input).toEqual([
      {
        type: "user_input",
        content: [{ type: "text", text: "Solve this problem" }],
      },
      {
        type: "thought",
        signature: "sig_step_1234==",
        summary: [{ type: "text", text: "Let me break down the steps." }],
      },
      {
        type: "model_output",
        content: [{ type: "text", text: "Here is the answer." }],
      },
      {
        type: "user_input",
        content: [{ type: "text", text: "Tell me more" }],
      },
    ]);
  });

  it("preserves chronological model step order in stateless replay", () => {
    const params = buildGoogleInteractionsParams(
      model,
      {
        messages: [
          user("Solve this"),
          assistant([
            { type: "text", text: "First result" },
            {
              type: "thinking",
              thinking: "Then reason",
              thinkingSignature: "sig_ordered_thought==",
            },
            { type: "text", text: "Second result" },
          ]),
        ],
      },
      {},
    );

    expect(params.input).toEqual([
      { type: "user_input", content: [{ type: "text", text: "Solve this" }] },
      { type: "model_output", content: [{ type: "text", text: "First result" }] },
      {
        type: "thought",
        signature: "sig_ordered_thought==",
        summary: [{ type: "text", text: "Then reason" }],
      },
      { type: "model_output", content: [{ type: "text", text: "Second result" }] },
    ]);
  });

  it("emits thought signatures in separate thought steps and not on function_call steps", () => {
    const context: Context = {
      messages: [
        user("Weather in Tokyo?"),
        assistant([
          {
            type: "toolCall",
            id: "call_123",
            name: "getWeather",
            arguments: { city: "Tokyo" },
            thoughtSignature: "sig_tool_call_token==",
          },
        ]),
      ],
    };

    const params = buildGoogleInteractionsParams(model, context, {});

    expect(params.input).toEqual([
      {
        type: "user_input",
        content: [{ type: "text", text: "Weather in Tokyo?" }],
      },
      {
        type: "thought",
        signature: "sig_tool_call_token==",
      },
      {
        type: "function_call",
        id: "call_123",
        name: "getWeather",
        arguments: { city: "Tokyo" },
      },
      {
        type: "function_result",
        call_id: "call_123",
        name: "getWeather",
        result: [{ type: "text", text: "No result provided" }],
        is_error: true,
      },
    ]);
  });

  it("converts assistant message with both thinking and toolCall into separate thought and function_call steps", () => {
    const context: Context = {
      messages: [
        user("Weather in Tokyo?"),
        assistant([
          {
            type: "thinking",
            thinking: "Looking up weather in Tokyo...",
            thinkingSignature: "sig_reasoning_token==",
          },
          {
            type: "toolCall",
            id: "call_123",
            name: "getWeather",
            arguments: { city: "Tokyo" },
          },
        ]),
      ],
    };

    const params = buildGoogleInteractionsParams(model, context, {});

    expect(params.input).toEqual([
      {
        type: "user_input",
        content: [{ type: "text", text: "Weather in Tokyo?" }],
      },
      {
        type: "thought",
        signature: "sig_reasoning_token==",
        summary: [{ type: "text", text: "Looking up weather in Tokyo..." }],
      },
      {
        type: "function_call",
        id: "call_123",
        name: "getWeather",
        arguments: { city: "Tokyo" },
      },
      {
        type: "function_result",
        call_id: "call_123",
        name: "getWeather",
        result: [{ type: "text", text: "No result provided" }],
        is_error: true,
      },
    ]);
  });

  it("does not attach dummy skip_thought_signature_validator to function_call steps for Gemini 3 models", () => {
    const context: Context = {
      messages: [
        user("Calculate 2+2"),
        assistant([
          {
            type: "toolCall",
            id: "call_calc",
            name: "calculator",
            arguments: { expr: "2+2" },
          },
        ]),
      ],
    };

    const params = buildGoogleInteractionsParams(model, context, {});

    expect(params.input).toEqual([
      {
        type: "user_input",
        content: [{ type: "text", text: "Calculate 2+2" }],
      },
      {
        type: "function_call",
        id: "call_calc",
        name: "calculator",
        arguments: { expr: "2+2" },
      },
      {
        type: "function_result",
        call_id: "call_calc",
        name: "calculator",
        result: [{ type: "text", text: "No result provided" }],
        is_error: true,
      },
    ]);
  });

  it("resolves the documented Gemini API partner client header x-goog-api-client", () => {
    const headers = resolveGoogleApiClientHeaders({
      baseUrl: "https://generativelanguage.googleapis.com",
    });
    expect(headers["x-goog-api-client"]).toMatch(/^openclaw\//u);
  });

  it("rejects unsupported explicit prompt caching locally", () => {
    const context: Context = {
      messages: [user("Hello")],
    };

    expect(() =>
      buildGoogleInteractionsParams(model, context, {
        cachedContent: "cachedContents/123",
      } as Record<string, unknown>),
    ).toThrow(/Explicit prompt caching/);
  });

  it.each(["auto", "none", "any"] as const)(
    "maps toolChoice=%s into generation_config",
    (toolChoice) => {
      const params = buildGoogleInteractionsParams(
        model,
        {
          messages: [user("Use a tool")],
          tools: [
            {
              name: "lookup",
              description: "Look up a value",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
        { toolChoice },
      );

      expect(params.generation_config?.tool_choice).toBe(toolChoice);
    },
  );

  it("applies the model's minimum supported reasoning when direct options disable thinking", () => {
    const params = buildGoogleInteractionsParams(
      { ...model, reasoning: true },
      { messages: [user("Answer briefly")] },
      { thinking: { enabled: false } },
    );

    expect(params.generation_config).toEqual({
      thinking_level: "minimal",
      thinking_summaries: "none",
    });
  });

  it("strips incompatible thought signatures and repairs missing tool results before conversion", () => {
    const params = buildGoogleInteractionsParams(
      model,
      {
        messages: [
          user("Use a tool"),
          assistant(
            [
              {
                type: "thinking",
                thinking: "Reasoning from the old transport",
                thinkingSignature: "incompatible-signature",
              },
              {
                type: "toolCall",
                id: "call_legacy",
                name: "lookup",
                arguments: { query: "value" },
                thoughtSignature: "incompatible-tool-signature",
              },
            ],
            { api: "google-generative-ai" },
          ),
        ],
      },
      {},
    );

    expect(params.input).toEqual([
      { type: "user_input", content: [{ type: "text", text: "Use a tool" }] },
      {
        type: "model_output",
        content: [{ type: "text", text: "Reasoning from the old transport" }],
      },
      {
        type: "function_call",
        id: "call_legacy",
        name: "lookup",
        arguments: { query: "value" },
      },
      {
        type: "function_result",
        call_id: "call_legacy",
        name: "lookup",
        result: [{ type: "text", text: "No result provided" }],
        is_error: true,
      },
    ]);
    expect(JSON.stringify(params.input)).not.toContain("incompatible-signature");
  });

  it("normalizes toolResult image blocks to snake_case mime_type", () => {
    const context: Context = {
      messages: [
        user("Read the file"),
        assistant([
          {
            type: "toolCall",
            id: "call_read_1",
            name: "read",
            arguments: { path: "test.png" },
          },
        ]),
        toolResult("call_read_1", "read", [
          { type: "text", text: "Read image file" },
          {
            type: "image",
            mimeType: "image/png",
            data: "base64data",
          },
        ]),
      ],
    };

    const params = buildGoogleInteractionsParams(
      { ...model, input: ["text", "image"] },
      context,
      {},
    );

    expect(params.input).toEqual([
      {
        type: "user_input",
        content: [{ type: "text", text: "Read the file" }],
      },
      {
        type: "function_call",
        id: "call_read_1",
        name: "read",
        arguments: { path: "test.png" },
      },
      {
        type: "function_result",
        call_id: "call_read_1",
        name: "read",
        is_error: false,
        result: [
          { type: "text", text: "Read image file" },
          {
            type: "image",
            mime_type: "image/png",
            data: "base64data",
          },
        ],
      },
    ]);
  });
});
