import type { Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";
import {
  buildOpenAIResponsesCompactSystemMessage,
  buildOpenAIResponsesParams,
  sanitizeOpenAICodexResponsesParams,
} from "./openai-responses-params-internal.js";

const reasoningModel = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 256_000,
  maxTokens: 8_192,
} satisfies Model<"openai-responses">;

describe("Responses explicit prompt caching", () => {
  const context = {
    systemPrompt: `Stable instructions${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic turn context`,
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
  } as const;

  it.each(["short", "long"] as const)(
    "preserves the stable boundary and native lifetime for %s retention",
    (cacheRetention) => {
      const params = buildOpenAIResponsesParams(
        reasoningModel,
        {
          ...context,
          messages: [...context.messages],
        },
        { cacheRetention, sessionId: "session-123" },
      );

      expect(params).not.toHaveProperty("instructions");
      expect(params.prompt_cache_options).toEqual({
        mode: "explicit",
        ...(cacheRetention === "long" ? { ttl: "30m" } : {}),
      });
      expect(params).not.toHaveProperty("prompt_cache_retention");
      expect(params.input).toEqual([
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "Stable instructions",
              prompt_cache_breakpoint: { mode: "explicit" },
            },
            { type: "input_text", text: "Dynamic turn context" },
          ],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      ]);
    },
  );

  it("honors a verified compatible provider's explicit-cache declaration", () => {
    const model = {
      ...reasoningModel,
      id: "openai.gpt-5.6-terra",
      name: "openai.gpt-5.6-terra",
      api: "openclaw-openai-responses-transport",
      provider: "amazon-bedrock-mantle",
      baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
      compat: {
        supportsExplicitPromptCaching: true,
        supportsPromptCacheKey: true,
        supportsLongCacheRetention: false,
      },
    } satisfies Model;
    const params = buildOpenAIResponsesParams(
      model,
      {
        ...context,
        messages: [...context.messages],
      },
      { cacheRetention: "long", sessionId: "session-123" },
    );

    expect(params.prompt_cache_options).toEqual({ mode: "explicit" });
    expect(params).not.toHaveProperty("prompt_cache_retention");
    expect(JSON.stringify(params.input)).toContain("prompt_cache_breakpoint");
  });

  it("disables cache writes without discarding current instructions", () => {
    const params = buildOpenAIResponsesParams(
      reasoningModel,
      {
        ...context,
        messages: [...context.messages],
      },
      { cacheRetention: "none", sessionId: "session-123" },
    );

    expect(params.prompt_cache_options).toEqual({ mode: "explicit" });
    expect(params.prompt_cache_key).toBeUndefined();
    expect(params.instructions).toBe("Stable instructions\nDynamic turn context");
    expect(JSON.stringify(params.input)).not.toContain("prompt_cache_breakpoint");
  });

  it.each([
    { provider: "custom-provider", baseUrl: "https://proxy.example.com/v1" },
    { id: "gpt-5.5", name: "GPT-5.6 Luna" },
    { compat: { supportsExplicitPromptCaching: false } },
  ])("keeps unverified or opted-out models implicit: %j", (overrides) => {
    const params = buildOpenAIResponsesParams(
      { ...reasoningModel, ...overrides },
      {
        ...context,
        messages: [...context.messages],
      },
      { sessionId: "session-123" },
    );

    expect(params).not.toHaveProperty("prompt_cache_options");
    expect(JSON.stringify(params.input)).not.toContain("prompt_cache_breakpoint");
  });
});

describe("sanitizeOpenAICodexResponsesParams", () => {
  it.each([
    "https://chatgpt.com/backend-api/codex",
    "https://chatgpt.com/backend-api/codex/responses",
  ])("restores stateless Codex payload policy after hooks at %s", (baseUrl) => {
    const codexModel = {
      ...reasoningModel,
      api: "openai-chatgpt-responses",
      baseUrl,
    } satisfies Model;
    const params = sanitizeOpenAICodexResponsesParams(codexModel, {
      model: codexModel.id,
      store: true,
      max_output_tokens: 128,
      metadata: { purpose: "dashboard-title" },
      text: { format: { type: "text" }, verbosity: "low" },
    });

    expect(params.store).toBe(false);
    expect(params).not.toHaveProperty("max_output_tokens");
    expect(params).not.toHaveProperty("metadata");
    expect(params.text).toEqual({ verbosity: "low" });
  });

  it("does not rewrite non-Codex Responses endpoints", () => {
    const params = sanitizeOpenAICodexResponsesParams(reasoningModel, {
      store: true,
      max_output_tokens: 128,
    });

    expect(params).toEqual({ store: true, max_output_tokens: 128 });
  });
});

describe("buildOpenAIResponsesCompactSystemMessage", () => {
  it("uses the developer role for reasoning models that support it", () => {
    expect(
      buildOpenAIResponsesCompactSystemMessage(reasoningModel, "Retain the conversation."),
    ).toEqual({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Retain the conversation." }],
    });
  });

  it("falls back to the system role for xAI's native route, which disables the developer role", () => {
    const message = buildOpenAIResponsesCompactSystemMessage(
      { ...reasoningModel, provider: "xai", baseUrl: "https://api.x.ai/v1" },
      "Retain the conversation.",
    );
    expect(message.role).toBe("system");
  });

  it("uses the system role for non-reasoning models", () => {
    const message = buildOpenAIResponsesCompactSystemMessage(
      { ...reasoningModel, reasoning: false },
      "Retain the conversation.",
    );
    expect(message.role).toBe("system");
  });
});
