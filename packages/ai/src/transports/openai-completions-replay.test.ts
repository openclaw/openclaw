import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { preparedRequestSuffix } from "../provider-options.js";
import type { Context, Model } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { resolveOpenAICompletionsCompat } from "./openai-completions-compat.js";
import {
  buildOpenAICompletionsRequest,
  buildOpenAICompletionsParams,
} from "./openai-completions-params.js";
import { applyCompletionsReplay } from "./openai-completions-replay.js";
import {
  makeCompletionsModel,
  openRouterModel,
  openRouterAnthropicModel,
  openRouterXaiModel,
  openAIModel,
  nativeDeepSeekModel,
  nativeZaiModel,
  xiaomiModel,
  customMiMoProxyModel,
  customKimiProxyModel,
  staleKimiK27Model,
  customQwenReasoningModel,
  customReasoningProxyModel,
  getAssistantMessage,
  buildReplayParams,
} from "./openai-completions.test-support.js";
import { getCompat } from "./openai-transport-params.js";

describe("Chat Completions historical tools", () => {
  const replayTool = {
    name: "lookup_weather",
    description: "Get forecast",
    parameters: { type: "object" },
  };
  it.each(["direct", "managed"] as const)(
    "projects undeclared history against the outgoing catalog without changing the transcript (%s)",
    (mode) => {
      const model = makeCompletionsModel({
        provider: "strict-provider",
        baseUrl: "https://strict.example/v1",
        reasoning: false,
        compat: { requiresAssistantAfterToolResult: true },
      });
      const policy =
        mode === "direct"
          ? { mode, compat: resolveOpenAICompletionsCompat(model), cacheRetention: "none" as const }
          : { mode };
      for (const unavailable of ["session_status", "unusable"]) {
        const calls = [
          { name: "lookup_weather", id: "call:0|fc_item" },
          { name: unavailable, id: "call_bad" },
          { name: "lookup_weather", id: "call_2" },
        ];
        const context: Context = {
          tools: [
            replayTool,
            { name: "unusable", description: "Rejected schema", parameters: { default: 1n } },
          ],
          messages: [
            {
              role: "assistant",
              api: model.api,
              provider: model.provider,
              model: model.id,
              content: calls.map(({ name, id }) => ({
                type: "toolCall",
                id,
                name,
                arguments: {},
              })),
              usage: createZeroUsage(),
              stopReason: "toolUse",
              timestamp: 1,
            },
            ...calls.map(({ name, id }, i) =>
              makeTextToolResult(
                id,
                "stale_metadata",
                i === 1 ? `Tool ${name} not found` : "sunny",
                i === 1,
                2,
              ),
            ),
            { role: "user", content: "Continue", timestamp: 3 },
          ],
        };
        const original = structuredClone(context);
        const params = buildOpenAICompletionsRequest(model, context, undefined, policy);
        expect(params.tools?.map((entry) => entry.function.name)).toEqual(["lookup_weather"]);
        expect(params.messages).toEqual([
          {
            role: "assistant",
            content: `[tool call id=call_bad name=${unavailable}] {}`,
            tool_calls: [
              {
                id: "call:0|fc_item",
                type: "function",
                function: { name: "lookup_weather", arguments: "{}" },
              },
              {
                id: "call_2",
                type: "function",
                function: { name: "lookup_weather", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call:0|fc_item", content: "sunny" },
          { role: "tool", tool_call_id: "call_2", content: "sunny" },
          {
            role: "assistant",
            content: `[tool result id=call_bad name=stale_metadata] Tool ${unavailable} not found`,
          },
          { role: "user", content: "Continue" },
        ]);
        expect(context).toEqual(original);
        const next = buildOpenAICompletionsRequest(
          model,
          {
            ...context,
            messages: [...context.messages, { role: "user", content: "Again", timestamp: 4 }],
          },
          undefined,
          policy,
        );
        expect(next.messages.slice(0, -1)).toEqual(params.messages);
      }
    },
  );

  it("keeps captured-prefix native result IDs and projects unavailable suffix results as text", () => {
    const context: Context = {
      tools: [replayTool],
      messages: [
        makeTextToolResult("call:0|fc_item", "stale_metadata", "sunny", false, 1),
        makeTextToolResult("call_bad", "session_status", "Tool session_status not found", true, 2),
      ],
    };
    preparedRequestSuffix.mark(context, new Set(["call_0"]));
    expect(buildOpenAICompletionsParams(openAIModel, context, undefined).messages).toEqual([
      { role: "tool", tool_call_id: "call_0", content: "sunny" },
      {
        role: "assistant",
        content: "[tool result id=call_bad name=session_status] Tool session_status not found",
      },
    ]);
  });
});

describe("buildOpenAICompletionsParams sanitizes reasoning replay fields", () => {
  it.each([
    ["native reasoning", "native reasoning"],
    ["", "streamed reasoning"],
  ])("prefers nonempty reasoning_content when explicitly required (%j)", (native, expected) => {
    const model = {
      ...customReasoningProxyModel,
      compat: { requiresReasoningContentOnAssistantMessages: true },
    };
    const message = {
      role: "assistant" as const,
      content: "Answer",
      reasoning_content: native,
      reasoning: "streamed reasoning",
      reasoning_text: "alternate reasoning",
      reasoning_details: "not replayable here",
    };
    applyCompletionsReplay([message], { messages: [] }, model, getCompat(model));
    expect(message).toEqual({ role: "assistant", content: "Answer", reasoning_content: expected });
  });

  it.each(["reasoning_text"])(
    "strips %s from stock OpenAI Chat Completions assistant replay",
    (thinkingSignature) => {
      const assistant = getAssistantMessage(buildReplayParams(openAIModel, thinkingSignature));

      expect(assistant).not.toHaveProperty("reasoning_details");
      expect(assistant).not.toHaveProperty("reasoning_content");
      expect(assistant).not.toHaveProperty("reasoning");
      expect(assistant).not.toHaveProperty("reasoning_text");
    },
  );

  it("normalizes OpenRouter string reasoning_details to reasoning", () => {
    const assistant = getAssistantMessage(buildReplayParams(openRouterModel, "reasoning_details"));

    expect(assistant).not.toHaveProperty("reasoning_details");
    expect(assistant.reasoning).toBe("Need to answer politely.");
  });

  it.each([
    ["Anthropic", openRouterAnthropicModel],
    ["xAI", openRouterXaiModel],
  ] as const)("strips OpenRouter %s non-replayable reasoning fields", (_label, model) => {
    for (const thinkingSignature of [
      "reasoning_details",
      "reasoning_content",
      "reasoning",
      "reasoning_text",
    ]) {
      const assistant = getAssistantMessage(buildReplayParams(model, thinkingSignature));

      expect(assistant).not.toHaveProperty("reasoning_details");
      expect(assistant).not.toHaveProperty("reasoning_content");
      expect(assistant).not.toHaveProperty("reasoning");
      expect(assistant).not.toHaveProperty("reasoning_text");
    }
  });

  it("strips empty-string reasoning_content from OpenRouter assistant replay", () => {
    const params = buildOpenAICompletionsParams(
      openRouterModel,
      {
        systemPrompt: "system",
        messages: [
          { role: "user", content: "read config" },
          {
            role: "assistant",
            provider: "openrouter",
            api: "openai-completions",
            model: "deepseek/deepseek-v4-pro",
            stopReason: "toolUse",
            timestamp: 0,
            content: [
              {
                type: "thinking",
                thinking: "",
                thinkingSignature: "reasoning_content",
              },
              {
                type: "toolCall",
                id: "call_1",
                name: "read_file",
                arguments: { path: "config.json" },
              },
            ],
          },
          makeTextToolResult("call_1", "read_file", "{ }", false, 1),
          { role: "user", content: "continue" },
        ],
        tools: [],
      } as never,
      undefined,
    ) as { messages: Array<Record<string, unknown>> };

    const assistantMessages = params.messages.filter((msg) => msg.role === "assistant");
    for (const msg of assistantMessages) {
      expect(msg).not.toHaveProperty("reasoning_content");
    }
  });

  it.each([["Z.AI", nativeZaiModel]] as const)(
    "preserves native %s reasoning_content replay",
    (_label, model) => {
      const assistant = getAssistantMessage(buildReplayParams(model, "reasoning_content"));

      expect(assistant.reasoning_content).toBe("Need to answer politely.");
    },
  );

  it.each([["DeepSeek", nativeDeepSeekModel]] as const)(
    "strips non-native %s reasoning replay fields",
    (_label, model) => {
      const assistant = getAssistantMessage(buildReplayParams(model, "reasoning_details"));

      expect(assistant).not.toHaveProperty("reasoning_details");
      expect(assistant).not.toHaveProperty("reasoning");
      expect(assistant).not.toHaveProperty("reasoning_text");
    },
  );

  it("normalizes OpenRouter reasoning_text to reasoning", () => {
    const assistant = getAssistantMessage(buildReplayParams(openRouterModel, "reasoning_text"));

    expect(assistant).not.toHaveProperty("reasoning_text");
    expect(assistant.reasoning).toBe("Need to answer politely.");
  });

  it.each([
    {
      label: "preserves reasoning_content replay for custom reasoning model metadata",
      model: customQwenReasoningModel,
      assertSanitizedFields: true,
    },
    {
      label: "preserves DeepSeek-style reasoning_content replay for Xiaomi MiMo",
      model: xiaomiModel,
      assertSanitizedFields: true,
    },
    {
      label: "preserves Kimi K2.7 reasoning_content replay with stale reasoning metadata",
      model: staleKimiK27Model,
      assertSanitizedFields: true,
    },
    {
      label: "preserves reasoning_content replay for suffixed reasoning model ids",
      model: { ...customMiMoProxyModel, id: "xiaomi/mimo-v2.5-pro:cloud", reasoning: false },
      assertSanitizedFields: false,
    },
    {
      label: "preserves reasoning_content replay for prefixed reasoning model ids",
      model: { ...customKimiProxyModel, id: "hf:moonshotai/kimi-k2-thinking", reasoning: false },
      assertSanitizedFields: false,
    },
  ] as const)("$label", ({ model, assertSanitizedFields }) => {
    const assistant = getAssistantMessage(buildReplayParams(model, "reasoning_content"));

    expect(assistant.reasoning_content).toBe("Need to answer politely.");
    if (assertSanitizedFields) {
      expect(assistant).not.toHaveProperty("reasoning_details");
      expect(assistant).not.toHaveProperty("reasoning");
      expect(assistant).not.toHaveProperty("reasoning_text");
    }
  });

  // Regression for #87575: OpenCode Zen exposes DeepSeek V4 with a `-free`
  // tier suffix that does not change the upstream replay contract. Without
  // matching the base id we stripped reasoning_content from the follow-up
  // request and DeepSeek rejected the assistant turn with HTTP 400.
  it.each([
    [
      "OpenCode Zen DeepSeek V4 Flash Free",
      {
        id: "deepseek-v4-flash-free",
        name: "DeepSeek V4 Flash Free",
        api: "openai-completions" as const,
        provider: "opencode",
        baseUrl: "https://opencode.ai/zen/v1",
        reasoning: false,
        input: ["text"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 65_536,
        maxTokens: 8192,
      },
    ],
  ] as const)("preserves reasoning_content replay despite the %s tier suffix", (_label, model) => {
    const assistant = getAssistantMessage(
      buildReplayParams(model as Model<"openai-completions">, "reasoning_content"),
    );

    expect(assistant.reasoning_content).toBe("Need to answer politely.");
    expect(assistant).not.toHaveProperty("reasoning_details");
    expect(assistant).not.toHaveProperty("reasoning");
    expect(assistant).not.toHaveProperty("reasoning_text");
  });

  it("preserves OpenRouter array reasoning_details from tool-call signatures", () => {
    const reasoningDetail = { type: "reasoning.encrypted", id: "rs_1", data: "ciphertext" };
    const params = buildOpenAICompletionsParams(
      openRouterModel,
      {
        systemPrompt: "system",
        messages: [
          { role: "user", content: "lookup" },
          {
            role: "assistant",
            provider: "openrouter",
            api: "openai-completions",
            model: "deepseek/deepseek-v4-flash",
            stopReason: "stop",
            timestamp: 0,
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "lookup",
                arguments: { query: "weather" },
                thoughtSignature: JSON.stringify(reasoningDetail),
              },
            ],
          },
          makeTextToolResult("call_1", "lookup", "sunny", false, 1),
          { role: "user", content: "answer" },
        ],
        tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
      } as never,
      undefined,
    ) as { messages: unknown };

    const assistant = getAssistantMessage(params);
    expect(assistant.reasoning_details).toEqual([reasoningDetail]);
  });

  it("honors compat.requiresReasoningContentOnAssistantMessages from config on a custom provider (#89660)", () => {
    const resolved = getCompat({
      ...customReasoningProxyModel,
      compat: { requiresReasoningContentOnAssistantMessages: true },
    } as never);

    expect(resolved.requiresReasoningContentOnAssistantMessages).toBe(true);
  });
});
