import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import type { Api } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  buildOpenAIResponsesParams,
  makeResponsesModel,
} from "./openai-transport-stream.test-harness.js";
import { testing } from "./openai-transport-stream.test-support.js";

const cacheContext = {
  systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
  messages: [{ role: "user", content: "Hello", timestamp: 1 }],
  tools: [],
} as const;
const cacheOptions = {
  cacheRetention: "long",
  maxTokens: 1024,
  serviceTier: "auto",
  sessionId: "session-123",
  temperature: 0.2,
  topP: 0.85,
} as const;
const metadata = { openclaw_session_id: "session-123", openclaw_turn_id: "turn-123" };
const unsupportedCodexParams = {
  metadata,
  max_output_tokens: 1024,
  prompt_cache_retention: "24h",
  prompt_cache_options: { ttl: "30m" },
  service_tier: "auto",
  temperature: 0.2,
  top_p: 0.85,
};
type CachedParams = Record<string, unknown> & { input?: Array<{ role?: string }> };
function expectCodexCache(params: CachedParams, cacheKey: string | undefined) {
  expect(params.prompt_cache_key).toBe(cacheKey);
  for (const key of Object.keys(unsupportedCodexParams)) {
    expect(params).not.toHaveProperty(key);
  }
}

const custom = makeResponsesModel({
  id: "synthetic-reasoner",
  provider: "custom-provider",
  baseUrl: "https://reasoning.example/v1",
  compat: { supportedReasoningEfforts: ["none", "low", "high"] },
  thinkingLevelMap: { off: "low" },
});
const grok = makeResponsesModel({
  id: "grok-4.3",
  provider: "xai",
  baseUrl: "https://api.x.ai/v1",
  compat: {
    supportsReasoningEffort: true,
    supportedReasoningEfforts: ["none", "low", "medium", "high"],
  },
});

describe("openai transport stream", () => {
  it.each([
    ["Grok default", grok, undefined, undefined, undefined],
    ["custom omitted", custom, undefined, undefined, undefined],
    [
      "custom logical off",
      custom,
      { reasoning: "off" },
      { effort: "low", summary: "auto" },
      ["reasoning.encrypted_content"],
    ],
    ["native none", custom, { reasoningEffort: "none" }, { effort: "none" }, undefined],
  ] as const)("preserves Responses %s intent", (_intent, model, options, reasoning, include) => {
    const params = buildOpenAIResponsesParams(
      model,
      { systemPrompt: "system", messages: [], tools: [] },
      options,
    );

    for (const [key, value] of [
      ["reasoning", reasoning],
      ["include", include],
    ] as const) {
      if (value === undefined) {
        expect(params).not.toHaveProperty(key);
      } else {
        expect(params[key]).toEqual(value);
      }
    }
  });

  it.each(["none", "long"] as const)(
    "preserves native ChatGPT cache identity with %s retention",
    (cacheRetention) => {
      const params = buildOpenAIResponsesParams(
        makeResponsesModel({
          id: "gpt-5.6-sol",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api",
        }),
        cacheContext as never,
        { ...cacheOptions, cacheRetention },
        metadata,
      ) as CachedParams;

      expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
      expect(params.input?.map((item) => item.role)).toEqual(["user"]);
      expectCodexCache(params, cacheRetention === "none" ? undefined : "session-123");
      expect(params.store).toBe(false);
    },
  );

  it("keeps Codex response shaping when simple completions use the OpenClaw transport alias", () => {
    const params = buildOpenAIResponsesParams(
      {
        ...makeResponsesModel(),
        id: "gpt-5.5",
        api: "openclaw-openai-chatgpt-responses-transport" as Api,
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      cacheContext as never,
      cacheOptions,
      metadata,
    ) as CachedParams;

    expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
    expect(params.input?.map((item) => item.role)).toEqual(["user"]);
    expectCodexCache(params, "session-123");
    expect(params.store).toBe(false);
  });

  it("sanitizes Codex responses params after payload hooks mutate them without stripping cache identity", () => {
    const payload = {
      ...unsupportedCodexParams,
      model: "gpt-5.4",
      input: [],
      stream: true,
      prompt_cache_key: "session-123",
      text: { format: { type: "json_object" }, verbosity: "low" },
    };

    const sanitized = testing.sanitizeOpenAICodexResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
      payload,
    );

    expectCodexCache(sanitized, "session-123");
    expect(sanitized.text).toEqual({ verbosity: "low" });
  });

  it("preserves custom Codex-compatible responses params", () => {
    const params = buildOpenAIResponsesParams(
      makeResponsesModel({
        id: "gpt-5.4",
        api: "openai-chatgpt-responses",
        baseUrl: "https://proxy.example.com/v1",
        // Custom URLs require explicit instruction/cache-key support.
        compat: { supportsInstructions: true, supportsPromptCacheKey: true },
      } as never),
      cacheContext as never,
      { ...cacheOptions, serviceTier: undefined },
      metadata,
    ) as Record<string, unknown>;

    expect(params.instructions).toBe("Stable prefix\nDynamic suffix");
    expect(params.prompt_cache_key).toBe("session-123");
    expect(params.metadata).toEqual(metadata);
    expect(params.max_output_tokens).toBe(1024);
    expect(params.temperature).toBe(0.2);
    expect(params.top_p).toBe(0.85);
  });
});
