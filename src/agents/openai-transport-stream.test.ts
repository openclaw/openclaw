import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  buildOpenAIResponsesParams,
  buildOpenAICompletionsParams,
  parseTransportChunkUsage,
  resolveAzureOpenAIApiVersion,
  sanitizeTransportPayloadText,
} from "./openai-transport-stream.js";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";
import {
  buildTransportAwareSimpleStreamFn,
  isTransportAwareApiSupported,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
} from "./provider-transport-stream.js";

describe("openai transport stream", () => {
  it("reports the supported transport-aware APIs", () => {
    expect(isTransportAwareApiSupported("openai-responses")).toBe(true);
    expect(isTransportAwareApiSupported("openai-completions")).toBe(true);
    expect(isTransportAwareApiSupported("azure-openai-responses")).toBe(true);
    expect(isTransportAwareApiSupported("anthropic-messages")).toBe(true);
    expect(isTransportAwareApiSupported("google-generative-ai")).toBe(true);
  });

  it("prepares a custom simple-completion api alias when transport overrides are attached", () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    const prepared = prepareTransportAwareSimpleModel(model);

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-openai-responses-transport");
    expect(prepared).toMatchObject({
      api: "openclaw-openai-responses-transport",
      provider: "openai",
      id: "gpt-5.4",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("prepares an Anthropic simple-completion api alias when transport overrides are attached", () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"anthropic-messages">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    const prepared = prepareTransportAwareSimpleModel(model);

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-anthropic-messages-transport");
    expect(prepared).toMatchObject({
      api: "openclaw-anthropic-messages-transport",
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("prepares a Google simple-completion api alias when transport overrides are attached", () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
        api: "google-generative-ai",
        provider: "google",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"google-generative-ai">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    const prepared = prepareTransportAwareSimpleModel(model);

    expect(resolveTransportAwareSimpleApi(model.api)).toBe(
      "openclaw-google-generative-ai-transport",
    );
    expect(prepared).toMatchObject({
      api: "openclaw-google-generative-ai-transport",
      provider: "google",
      id: "gemini-3.1-pro-preview",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("keeps github-copilot OpenAI-family models on the shared transport seam", () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-openai-responses-transport");
    expect(prepareTransportAwareSimpleModel(model)).toMatchObject({
      api: "openclaw-openai-responses-transport",
      provider: "github-copilot",
      id: "gpt-5.4",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("keeps github-copilot Claude models on the shared Anthropic transport seam", () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com/anthropic",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"anthropic-messages">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    expect(resolveTransportAwareSimpleApi(model.api)).toBe("openclaw-anthropic-messages-transport");
    expect(prepareTransportAwareSimpleModel(model)).toMatchObject({
      api: "openclaw-anthropic-messages-transport",
      provider: "github-copilot",
      id: "claude-sonnet-4.6",
    });
    expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
  });

  it("removes unpaired surrogate code units but preserves valid surrogate pairs", () => {
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xdc00);

    expect(sanitizeTransportPayloadText(`left${high}right`)).toBe("leftright");
    expect(sanitizeTransportPayloadText(`left${low}right`)).toBe("leftright");
    expect(sanitizeTransportPayloadText("emoji 🙈 ok")).toBe("emoji 🙈 ok");
  });

  it("uses a valid Azure API version default when the environment is unset", () => {
    expect(resolveAzureOpenAIApiVersion({})).toBe("2024-12-01-preview");
    expect(resolveAzureOpenAIApiVersion({ AZURE_OPENAI_API_VERSION: "2025-01-01-preview" })).toBe(
      "2025-01-01-preview",
    );
  });

  it("does not double-count reasoning tokens and clamps uncached prompt usage at zero", () => {
    const model = {
      id: "gpt-5",
      name: "GPT-5",
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">;

    expect(
      parseTransportChunkUsage(
        {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 7 },
        },
        model,
      ),
    ).toMatchObject({
      input: 7,
      output: 20,
      cacheRead: 3,
      totalTokens: 30,
    });

    expect(
      parseTransportChunkUsage(
        {
          prompt_tokens: 2,
          completion_tokens: 5,
          total_tokens: 7,
          prompt_tokens_details: { cached_tokens: 4 },
        },
        model,
      ),
    ).toMatchObject({
      input: 0,
      output: 5,
      cacheRead: 4,
      totalTokens: 9,
    });
  });

  it("keeps OpenRouter thinking format for declared OpenRouter providers on custom proxy URLs", async () => {
    const streamFn = buildTransportAwareSimpleStreamFn(
      attachModelProviderRequestTransport(
        {
          id: "anthropic/claude-sonnet-4",
          name: "Claude Sonnet 4",
          api: "openai-completions",
          provider: "openrouter",
          baseUrl: "https://proxy.example.com/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 8192,
        } satisfies Model<"openai-completions">,
        {
          proxy: {
            mode: "explicit-proxy",
            url: "http://proxy.internal:8443",
          },
        },
      ),
    );

    expect(streamFn).toBeTypeOf("function");
    let capturedPayload: Record<string, unknown> | undefined;
    let resolveCaptured!: () => void;
    const captured = new Promise<void>((resolve) => {
      resolveCaptured = resolve;
    });

    void streamFn!(
      {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        api: "openclaw-openai-completions-transport",
        provider: "openrouter",
        baseUrl: "https://proxy.example.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as Model<"openclaw-openai-completions-transport">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoningEffort: "high",
        onPayload: async (payload: unknown) => {
          capturedPayload = payload as Record<string, unknown>;
          resolveCaptured();
          return payload;
        },
      } as never,
    );

    await captured;

    expect(capturedPayload).toMatchObject({
      reasoning: {
        effort: "high",
      },
    });
  });

  it("keeps OpenRouter thinking format for native OpenRouter hosts behind custom provider ids", async () => {
    const streamFn = buildTransportAwareSimpleStreamFn(
      attachModelProviderRequestTransport(
        {
          id: "anthropic/claude-sonnet-4",
          name: "Claude Sonnet 4",
          api: "openai-completions",
          provider: "custom-openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 8192,
        } satisfies Model<"openai-completions">,
        {
          proxy: {
            mode: "explicit-proxy",
            url: "http://proxy.internal:8443",
          },
        },
      ),
    );

    expect(streamFn).toBeTypeOf("function");
    let capturedPayload: Record<string, unknown> | undefined;
    let resolveCaptured!: () => void;
    const captured = new Promise<void>((resolve) => {
      resolveCaptured = resolve;
    });

    void streamFn!(
      {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        api: "openclaw-openai-completions-transport",
        provider: "custom-openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as Model<"openclaw-openai-completions-transport">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        reasoningEffort: "high",
        onPayload: async (payload: unknown) => {
          capturedPayload = payload as Record<string, unknown>;
          resolveCaptured();
          return payload;
        },
      } as never,
    );

    await captured;

    expect(capturedPayload).toMatchObject({
      reasoning: {
        effort: "high",
      },
    });
  });

  it("uses system role instead of developer for responses providers that disable developer role", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "grok-4.1-fast",
        name: "Grok 4.1 Fast",
        api: "openai-responses",
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { input?: Array<{ role?: string }> };

    expect(params.input?.[0]).toMatchObject({ role: "system" });
  });

  it("keeps developer role for native OpenAI reasoning responses models", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { input?: Array<{ role?: string }> };

    expect(params.input?.[0]).toMatchObject({ role: "developer" });
  });

  it("gates responses service_tier to native OpenAI endpoints", () => {
    const nativeParams = buildOpenAIResponsesParams(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        serviceTier: "priority",
      },
    ) as { service_tier?: unknown };
    const proxyParams = buildOpenAIResponsesParams(
      {
        id: "custom-model",
        name: "Custom Model",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://proxy.example.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        serviceTier: "priority",
      },
    ) as { service_tier?: unknown };

    expect(nativeParams.service_tier).toBe("priority");
    expect(proxyParams).not.toHaveProperty("service_tier");
  });

  it("strips store when responses compat disables it", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "custom-model",
        name: "Custom Model",
        api: "openai-responses",
        provider: "custom-provider",
        baseUrl: "https://proxy.example.com/v1",
        compat: { supportsStore: false },
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as never,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { store?: unknown };

    expect(params).not.toHaveProperty("store");
  });

  it("uses system role for xAI default-route responses providers without relying on baseUrl host sniffing", () => {
    const params = buildOpenAIResponsesParams(
      {
        id: "grok-4.1-fast",
        name: "Grok 4.1 Fast",
        api: "openai-responses",
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-responses">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { input?: Array<{ role?: string }> };

    expect(params.input?.[0]).toMatchObject({ role: "system" });
  });

  it("uses system role for Moonshot default-route completions providers", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "kimi-k2.5",
        name: "Kimi K2.5",
        api: "openai-completions",
        provider: "moonshot",
        baseUrl: "",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as { messages?: Array<{ role?: string }> };

    expect(params.messages?.[0]).toMatchObject({ role: "system" });
  });

  it("uses system role and streaming usage compat for native ModelStudio completions providers", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "qwen3.6-plus",
        name: "Qwen 3.6 Plus",
        api: "openai-completions",
        provider: "modelstudio",
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      undefined,
    ) as {
      messages?: Array<{ role?: string }>;
      stream_options?: { include_usage?: boolean };
    };

    expect(params.messages?.[0]).toMatchObject({ role: "system" });
    expect(params.stream_options).toMatchObject({ include_usage: true });
  });

  it("disables developer-role-only compat defaults for configured custom proxy completions providers", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "custom-model",
        name: "Custom Model",
        api: "openai-completions",
        provider: "custom-cpa",
        baseUrl: "https://proxy.example.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
      {
        reasoningEffort: "high",
      } as never,
    ) as {
      messages?: Array<{ role?: string }>;
      reasoning_effort?: unknown;
      stream_options?: unknown;
      store?: unknown;
      tools?: Array<{ function?: { strict?: boolean } }>;
    };

    expect(params.messages?.[0]).toMatchObject({ role: "system" });
    expect(params).not.toHaveProperty("reasoning_effort");
    expect(params).not.toHaveProperty("stream_options");
    expect(params).not.toHaveProperty("store");
    expect(params.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("uses max_tokens for Chutes default-route completions providers without relying on baseUrl host sniffing", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "zai-org/GLM-4.7-TEE",
        name: "GLM 4.7 TEE",
        api: "openai-completions",
        provider: "chutes",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as never,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        maxTokens: 2048,
      } as never,
    );

    expect(params.max_tokens).toBe(2048);
    expect(params).not.toHaveProperty("max_completion_tokens");
  });

  it("omits strict tool shaping for Z.ai default-route completions providers", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "glm-5",
        name: "GLM 5",
        api: "openai-completions",
        provider: "zai",
        baseUrl: "",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } satisfies Model<"openai-completions">,
      {
        systemPrompt: "system",
        messages: [],
        tools: [
          {
            name: "lookup_weather",
            description: "Get forecast",
            parameters: { type: "object", properties: {} },
          },
        ],
      } as never,
      undefined,
    ) as { tools?: Array<{ function?: { strict?: boolean } }> };

    expect(params.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("uses Mistral compat defaults for direct Mistral completions providers", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "mistral-large-latest",
        name: "Mistral Large",
        api: "openai-completions",
        provider: "mistral",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as never,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        maxTokens: 2048,
        reasoningEffort: "high",
      } as never,
    );

    expect(params).toMatchObject({
      max_tokens: 2048,
    });
    expect(params).not.toHaveProperty("max_completion_tokens");
    expect(params).not.toHaveProperty("store");
    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("uses Mistral compat defaults for custom providers on native Mistral hosts", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "mistral-small-latest",
        name: "Mistral Small",
        api: "openai-completions",
        provider: "custom-mistral-host",
        baseUrl: "https://api.mistral.ai/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      } as never,
      {
        systemPrompt: "system",
        messages: [],
        tools: [],
      } as never,
      {
        maxTokens: 2048,
        reasoningEffort: "high",
      } as never,
    );

    expect(params).toMatchObject({
      max_tokens: 2048,
    });
    expect(params).not.toHaveProperty("max_completion_tokens");
    expect(params).not.toHaveProperty("store");
    expect(params).not.toHaveProperty("reasoning_effort");
  });
});
