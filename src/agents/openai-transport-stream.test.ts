import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  buildTransportAwareSimpleStreamFn,
  isTransportAwareApiSupported,
  parseTransportChunkUsage,
  prepareTransportAwareSimpleModel,
  resolveAzureOpenAIApiVersion,
  resolveTransportAwareSimpleApi,
  sanitizeTransportPayloadText,
} from "./openai-transport-stream.js";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";

describe("openai transport stream", () => {
  it("reports the supported transport-aware APIs", () => {
    expect(isTransportAwareApiSupported("openai-responses")).toBe(true);
    expect(isTransportAwareApiSupported("openai-completions")).toBe(true);
    expect(isTransportAwareApiSupported("azure-openai-responses")).toBe(true);
    expect(isTransportAwareApiSupported("anthropic-messages")).toBe(false);
  });

  it("prepares a custom simple-completion api alias when transport overrides are attached", () => {
    const model = attachModelProviderRequestTransport(
      {
        id: "gpt-5",
        name: "GPT-5",
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
      id: "gpt-5",
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
        onPayload: async (payload) => {
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
});
