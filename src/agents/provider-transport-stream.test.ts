import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";
import {
  buildTransportAwareSimpleStreamFn,
  createBoundaryAwareStreamFnForModel,
  createTransportAwareStreamFnForModel,
  isTransportAwareApiSupported,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
} from "./provider-transport-stream.js";

function buildModel<TApi extends Api>(
  api: TApi,
  params: {
    id: string;
    provider: string;
    baseUrl: string;
  },
): Model<TApi> {
  return {
    id: params.id,
    name: params.id,
    api,
    provider: params.provider,
    baseUrl: params.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

describe("provider transport stream contracts", () => {
  it("covers the supported transport api alias matrix", () => {
    const cases = [
      {
        api: "openai-responses" as const,
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
        alias: "openclaw-openai-responses-transport",
      },
      {
        api: "openai-codex-responses" as const,
        provider: "openai-codex",
        id: "codex-mini-latest",
        baseUrl: "https://chatgpt.com/backend-api",
        alias: "openclaw-openai-responses-transport",
      },
      {
        api: "openai-completions" as const,
        provider: "xai",
        id: "grok-4",
        baseUrl: "https://api.x.ai/v1",
        alias: "openclaw-openai-completions-transport",
      },
      {
        api: "azure-openai-responses" as const,
        provider: "azure-openai-responses",
        id: "gpt-5.4",
        baseUrl: "https://example.openai.azure.com/openai/v1",
        alias: "openclaw-azure-openai-responses-transport",
      },
      {
        api: "anthropic-messages" as const,
        provider: "anthropic",
        id: "claude-sonnet-4.6",
        baseUrl: "https://api.anthropic.com",
        alias: "openclaw-anthropic-messages-transport",
      },
      {
        api: "google-generative-ai" as const,
        provider: "google",
        id: "gemini-3.1-pro-preview",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        alias: "openclaw-google-generative-ai-transport",
        providerOwnedRuntime: true,
      },
    ];

    for (const testCase of cases) {
      const model = attachModelProviderRequestTransport(
        buildModel(testCase.api, {
          id: testCase.id,
          provider: testCase.provider,
          baseUrl: testCase.baseUrl,
        }),
        {
          proxy: {
            mode: "explicit-proxy",
            url: "http://proxy.internal:8443",
          },
        },
      );

      expect(isTransportAwareApiSupported(testCase.api)).toBe(true);
      expect(resolveTransportAwareSimpleApi(testCase.api)).toBe(testCase.alias);
      if (testCase.providerOwnedRuntime) {
        continue;
      }
      expect(createBoundaryAwareStreamFnForModel(model)).toBeTypeOf("function");
      expect(createTransportAwareStreamFnForModel(model)).toBeTypeOf("function");
      expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
      expect(prepareTransportAwareSimpleModel(model)).toMatchObject({
        api: testCase.alias,
        provider: testCase.provider,
        id: testCase.id,
      });
    }
  });

  it("fails closed when truly unsupported apis carry transport overrides", () => {
    // 'ollama' is now supported (OpenAI-completions alias) — use a genuinely
    // unsupported api to keep the "fails closed" contract tested. (#69683)
    const model = attachModelProviderRequestTransport(
      buildModel("mistral-conversations" as Api, {
        id: "mistral-small",
        provider: "mistral",
        baseUrl: "https://api.mistral.ai/v1",
      }),
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    expect(isTransportAwareApiSupported(model.api)).toBe(false);
    expect(resolveTransportAwareSimpleApi(model.api)).toBeUndefined();
    expect(createBoundaryAwareStreamFnForModel(model)).toBeUndefined();
    expect(() => createTransportAwareStreamFnForModel(model)).toThrow(
      'Model-provider request.proxy/request.tls is not yet supported for api "mistral-conversations"',
    );
  });

  it("keeps truly unsupported apis unchanged when no transport overrides are attached", () => {
    // 'ollama' is now supported — use a genuinely unsupported api. (#69683)
    const model = buildModel("mistral-conversations" as Api, {
      id: "mistral-small",
      provider: "mistral",
      baseUrl: "https://api.mistral.ai/v1",
    });

    expect(createTransportAwareStreamFnForModel(model)).toBeUndefined();
    expect(buildTransportAwareSimpleStreamFn(model)).toBeUndefined();
    expect(prepareTransportAwareSimpleModel(model)).toBe(model);
  });

  // --- #69683: Ollama OpenAI-completions transport registration ---

  it("registers ollama as a supported transport api (isTransportAwareApiSupported)", () => {
    expect(isTransportAwareApiSupported("ollama")).toBe(true);
  });

  it("resolves ollama to the openai-completions transport alias", () => {
    expect(resolveTransportAwareSimpleApi("ollama")).toBe(
      "openclaw-openai-completions-transport",
    );
  });

  it("returns a stream fn for ollama without transport overrides", () => {
    const model = buildModel("ollama", {
      id: "qwen3:32b",
      provider: "ollama",
      baseUrl: "http://localhost:11434",
    });

    // With ollama registered, createBoundaryAwareStreamFnForModel must return a fn.
    expect(createBoundaryAwareStreamFnForModel(model)).toBeTypeOf("function");
    // buildTransportAwareSimpleStreamFn returns undefined when there are no proxy/tls
    // overrides (it's only used for transport-override paths), which is correct.
    expect(buildTransportAwareSimpleStreamFn(model)).toBeUndefined();
    // prepareTransportAwareSimpleModel should return the model unchanged when there
    // are no transport overrides (no alias needed at this stage).
    expect(prepareTransportAwareSimpleModel(model)).toBe(model);
  });

  it("returns a transport stream fn for ollama when proxy overrides are present", () => {
    const model = attachModelProviderRequestTransport(
      buildModel("ollama", {
        id: "llama3.2",
        provider: "ollama",
        baseUrl: "http://localhost:11434",
      }),
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    // ollama is now in SUPPORTED_TRANSPORT_APIS — should not throw.
    expect(isTransportAwareApiSupported(model.api)).toBe(true);
    expect(() => createTransportAwareStreamFnForModel(model)).not.toThrow();
    expect(createTransportAwareStreamFnForModel(model)).toBeTypeOf("function");
  });

  it("prepares ollama model with transport alias when proxy override is present", () => {
    const model = attachModelProviderRequestTransport(
      buildModel("ollama", {
        id: "gemma3:27b",
        provider: "ollama",
        baseUrl: "http://localhost:11434",
      }),
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://corp-proxy:3128",
        },
      },
    );

    const prepared = prepareTransportAwareSimpleModel(model);
    // api should be aliased to the openclaw transport id.
    expect(prepared.api).toBe("openclaw-openai-completions-transport");
  });
});
