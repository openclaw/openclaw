import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import type { Api, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  buildOpenAIResponsesParams,
  makeResponsesModel,
} from "./openai-transport-stream.test-harness.js";
import { testing } from "./openai-transport-stream.test-support.js";

describe("openai transport stream", () => {
  it("preserves xAI Grok 4.3 default reasoning by omitting default none", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "grok-4.3",
        name: "Grok 4.3",
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
        input: ["text", "image"],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["none", "low", "medium", "high"],
        },
      }),
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { reasoning?: unknown; include?: string[] };

    expect(params).not.toHaveProperty("reasoning");
    expect(params).not.toHaveProperty("include");
  });

  it.each([
    { intent: "omitted", options: undefined, reasoning: undefined, include: undefined },
    {
      intent: "logical off",
      options: { reasoning: "off" },
      reasoning: { effort: "low", summary: "auto" },
      include: ["reasoning.encrypted_content"],
    },
    {
      intent: "native none",
      options: { reasoningEffort: "none" },
      reasoning: { effort: "none" },
      include: undefined,
    },
  ] as const)("preserves custom Responses $intent intent", ({ options, reasoning, include }) => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "synthetic-reasoner",
        provider: "custom-provider",
        baseUrl: "https://reasoning.example/v1",
        compat: { supportedReasoningEfforts: ["none", "low", "high"] },
        thinkingLevelMap: { off: "low" },
      }),
      { systemPrompt: "system", messages: [], tools: [] },
      options,
    );

    if (reasoning === undefined) {
      expect(params).not.toHaveProperty("reasoning");
    } else {
      expect(params.reasoning).toEqual(reasoning);
    }
    if (include === undefined) {
      expect(params).not.toHaveProperty("include");
    } else {
      expect(params.include).toEqual(include);
    }
  });

  it.each(["none", "long"] as const)(
    "preserves native ChatGPT cache identity with %s retention",
    (cacheRetention) => {
      const params = buildOpenAIResponsesParams(
        makeResponsesModel({
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api",
        }),
        {
          systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
          messages: [{ role: "user", content: "Hello", timestamp: 1 }],
          tools: [],
        } as never,
        {
          cacheRetention,
          maxTokens: 1024,
          serviceTier: "auto",
          sessionId: "session-123",
          temperature: 0.2,
          topP: 0.85,
        },
        {
          openclaw_session_id: "session-123",
          openclaw_turn_id: "turn-123",
        },
      ) as Record<string, unknown> & {
        input?: Array<{ role?: string }>;
        instructions?: string;
      };

      expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
      expect(Array.isArray(params.input)).toBe(true);
      expect(params.input?.map((item) => item.role)).toEqual(["user"]);
      expect(
        params.input?.filter((item) => item.role === "system" || item.role === "developer"),
      ).toStrictEqual([]);
      expect(params.prompt_cache_key).toBe(cacheRetention === "none" ? undefined : "session-123");
      expect(params.store).toBe(false);
      expect(params).not.toHaveProperty("metadata");
      expect(params).not.toHaveProperty("max_output_tokens");
      expect(params).not.toHaveProperty("prompt_cache_retention");
      expect(params).not.toHaveProperty("prompt_cache_options");
      expect(params).not.toHaveProperty("service_tier");
      expect(params).not.toHaveProperty("temperature");
      expect(params).not.toHaveProperty("top_p");
    },
  );

  it("keeps Codex response shaping when simple completions use the OpenClaw transport alias", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openclaw-openai-chatgpt-responses-transport" as Api,
        provider: "openai",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model,
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        tools: [],
      } as never,
      {
        cacheRetention: "long",
        maxTokens: 1024,
        serviceTier: "auto",
        sessionId: "session-123",
        temperature: 0.2,
        topP: 0.85,
      },
      {
        openclaw_session_id: "session-123",
        openclaw_turn_id: "turn-123",
      },
    ) as Record<string, unknown> & {
      input?: Array<{ role?: string }>;
      instructions?: string;
    };

    expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
    expect(params.input?.map((item) => item.role)).toEqual(["user"]);
    expect(params.prompt_cache_key).toBe("session-123");
    expect(params.store).toBe(false);
    expect(params).not.toHaveProperty("metadata");
    expect(params).not.toHaveProperty("max_output_tokens");
    expect(params).not.toHaveProperty("prompt_cache_retention");
    expect(params).not.toHaveProperty("service_tier");
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
  });

  it("sanitizes Codex responses params after payload hooks mutate them without stripping cache identity", () => {
    const payload = {
      model: "gpt-5.4",
      input: [],
      stream: true,
      max_output_tokens: 1024,
      metadata: { openclaw_session_id: "session-123" },
      prompt_cache_key: "session-123",
      prompt_cache_retention: "24h",
      prompt_cache_options: { ttl: "30m" },
      service_tier: "auto",
      temperature: 0.2,
      text: { format: { type: "json_object" }, verbosity: "low" },
      top_p: 0.85,
    };

    const sanitized = testing.sanitizeOpenAICodexResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
      payload,
    );

    expect(sanitized.prompt_cache_key).toBe("session-123");
    expect(sanitized).not.toHaveProperty("metadata");
    expect(sanitized).not.toHaveProperty("max_output_tokens");
    expect(sanitized).not.toHaveProperty("prompt_cache_retention");
    expect(sanitized).not.toHaveProperty("prompt_cache_options");
    expect(sanitized).not.toHaveProperty("service_tier");
    expect(sanitized).not.toHaveProperty("temperature");
    expect(sanitized.text).toEqual({ verbosity: "low" });
    expect(sanitized).not.toHaveProperty("top_p");
  });

  it("preserves custom Codex-compatible responses params", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://proxy.example.com/v1",
        // Unrecognized custom base URL: instructions default off unless
        // verified. This fixture is specifically testing param preservation
        // once instructions is in play, so opt in explicitly. `compat` types
        // to `never` for this API variant (no recognized branch in
        // Model<TApi>), matching the sibling `as never` casts in this file.
        compat: { supportsInstructions: true, supportsPromptCacheKey: true },
      } as never),
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        tools: [],
      } as never,
      {
        cacheRetention: "long",
        maxTokens: 1024,
        sessionId: "session-123",
        temperature: 0.2,
        topP: 0.85,
      },
      {
        openclaw_session_id: "session-123",
        openclaw_turn_id: "turn-123",
      },
    ) as Record<string, unknown>;

    expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
    expect(params.prompt_cache_key).toBe("session-123");
    expect(params.metadata).toEqual({
      openclaw_session_id: "session-123",
      openclaw_turn_id: "turn-123",
    });
    expect(params.max_output_tokens).toBe(1024);
    expect(params.temperature).toBe(0.2);
    expect(params.top_p).toBe(0.85);
  });
});
