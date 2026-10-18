import { DEFAULT_MISSING_TOOL_RESULT_TEXT } from "@openclaw/llm-core/types";
import { describe, expect, it } from "vitest";
import { createAssistantOutput } from "../transports/assistant-output.js";
import type { AssistantMessage, Context, Model, ToolResultMessage, UserMessage } from "../types.js";
import {
  buildGoogleInteractionsParams,
  resolveGoogleApiClientHeaders,
} from "./google-interactions-request.js";
import { makeModel } from "./google-shared.test-helpers.js";

const model = {
  ...makeModel("gemini-3-flash-preview"),
  api: "google-interactions",
} satisfies Model<"google-interactions">;
const text = (value: string) => ({ type: "text" as const, text: value });
const toolCall = (
  id: string,
  name: string,
  args: Record<string, unknown>,
  thoughtSignature?: string,
) => ({
  type: "toolCall" as const,
  id,
  name,
  arguments: args,
  thoughtSignature,
});
const user = (content: UserMessage["content"]): UserMessage => ({
  role: "user",
  content,
  timestamp: 0,
});
const step = (type: "user_input" | "model_output", value: string) => ({
  type,
  content: [text(value)],
});
function assistant(
  content: AssistantMessage["content"],
  identity: Partial<Pick<AssistantMessage, "api" | "provider" | "model">> = {},
): AssistantMessage {
  return { ...createAssistantOutput(model), ...identity, content, timestamp: 0 };
}
function params(
  messages: Context["messages"],
  options: Parameters<typeof buildGoogleInteractionsParams>[2] = {},
  target = model,
) {
  return buildGoogleInteractionsParams(target, { messages }, options);
}
const missingResult = (id: string, name: string) => ({
  type: "function_result",
  call_id: id,
  name,
  result: [text(DEFAULT_MISSING_TOOL_RESULT_TEXT)],
  is_error: true,
});

describe("buildGoogleInteractionsParams", () => {
  it("converts basic messages to user_input and model_output steps", () => {
    const converted = buildGoogleInteractionsParams(model, {
      systemPrompt: "You are a helpful assistant.",
      messages: [
        user("Hello"),
        assistant([text("Hi there!"), { type: "thinking", thinking: "internal thoughts" }]),
        user("What is 2+2?"),
        {
          ...user("OpenClaw runtime context:\ncurrent runtime facts"),
          timestamp: 1,
          runtimeContext: {},
        },
      ],
    });
    expect(converted).toEqual({
      model: "gemini-3-flash-preview",
      system_instruction: "You are a helpful assistant.",
      store: false,
      stream: true,
      input: [
        step("user_input", "Hello"),
        step("model_output", "Hi there!"),
        step("user_input", "What is 2+2?"),
        step("user_input", "OpenClaw runtime context:\ncurrent runtime facts"),
      ],
    });
  });

  it("preserves chronological model step order in stateless replay", () => {
    expect(
      params([
        user("Solve this"),
        assistant([
          text("First result"),
          { type: "thinking", thinking: "Then reason", thinkingSignature: "sig_ordered_thought==" },
          text("Second result"),
        ]),
      ]).input,
    ).toEqual([
      step("user_input", "Solve this"),
      step("model_output", "First result"),
      { type: "thought", signature: "sig_ordered_thought==", summary: [text("Then reason")] },
      step("model_output", "Second result"),
    ]);
  });

  it("emits thought signatures in separate thought steps and not on function_call steps", () => {
    expect(
      params([
        user("Weather in Tokyo?"),
        assistant([toolCall("call_123", "getWeather", { city: "Tokyo" }, "sig_tool_call_token==")]),
      ]).input,
    ).toEqual([
      step("user_input", "Weather in Tokyo?"),
      { type: "thought", signature: "sig_tool_call_token==" },
      { type: "function_call", id: "call_123", name: "getWeather", arguments: { city: "Tokyo" } },
      missingResult("call_123", "getWeather"),
    ]);
  });

  it("resolves the documented Gemini API partner client header x-goog-api-client", () => {
    expect(
      resolveGoogleApiClientHeaders({
        baseUrl: "https://generativelanguage.googleapis.com",
      })["x-goog-api-client"],
    ).toMatch(/^openclaw\//u);
  });

  it("rejects unsupported explicit prompt caching locally", () => {
    expect(() =>
      params([user("Hello")], {
        cachedContent: "cachedContents/123",
      } as Record<string, unknown>),
    ).toThrow(/Explicit prompt caching/);
  });

  it("maps an explicit tool choice into generation_config", () => {
    const converted = buildGoogleInteractionsParams(
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
      { toolChoice: "any" },
    );
    expect(converted.generation_config?.tool_choice).toBe("any");
  });

  it("applies the model's minimum supported reasoning when direct options disable thinking", () => {
    expect(
      params(
        [user("Answer briefly")],
        { thinking: { enabled: false } },
        {
          ...model,
          reasoning: true,
        },
      ).generation_config,
    ).toEqual({ thinking_level: "minimal", thinking_summaries: "none" });
  });

  it.each([true, false])(
    "preserves the caller output cap for Interactions thinking (enabled=%s)",
    (enabled) => {
      const converted = params(
        [user("Answer briefly")],
        {
          maxTokens: 64,
          thinking: { enabled, level: "LOW" },
        },
        { ...model, reasoning: true, maxTokens: 65536 },
      );
      const serialized = JSON.stringify(converted);
      expect(JSON.parse(serialized).generation_config).toEqual({
        max_output_tokens: 64,
        thinking_level: "low",
        thinking_summaries: enabled ? "auto" : "none",
      });
    },
  );

  it("strips incompatible thought signatures and repairs missing tool results before conversion", () => {
    const converted = params([
      user("Use a tool"),
      assistant(
        [
          {
            type: "thinking",
            thinking: "Reasoning from the old transport",
            thinkingSignature: "incompatible-signature",
          },
          toolCall("call_legacy", "lookup", { query: "value" }, "incompatible-tool-signature"),
        ],
        { api: "google-generative-ai" },
      ),
    ]);
    expect(converted.input).toEqual([
      step("user_input", "Use a tool"),
      step("model_output", "Reasoning from the old transport"),
      { type: "function_call", id: "call_legacy", name: "lookup", arguments: { query: "value" } },
      missingResult("call_legacy", "lookup"),
    ]);
    expect(JSON.stringify(converted.input)).not.toContain("incompatible-signature");
  });

  it("normalizes toolResult image blocks to snake_case mime_type", () => {
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_read_1",
      toolName: "read",
      isError: false,
      timestamp: 0,
      content: [
        text("Read image file"),
        { type: "image", mimeType: "image/png", data: "base64data" },
      ],
    };
    const converted = params(
      [
        user("Read the file"),
        assistant([toolCall("call_read_1", "read", { path: "test.png" })]),
        result,
      ],
      {},
      { ...model, input: ["text", "image"] },
    );
    expect(converted.input).toEqual([
      step("user_input", "Read the file"),
      { type: "function_call", id: "call_read_1", name: "read", arguments: { path: "test.png" } },
      {
        type: "function_result",
        call_id: "call_read_1",
        name: "read",
        is_error: false,
        result: [
          text("Read image file"),
          { type: "image", mime_type: "image/png", data: "base64data" },
        ],
      },
    ]);
  });
});
