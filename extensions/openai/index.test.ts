import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { createTestPluginApi } from "../../test/helpers/extensions/plugin-api.js";
import plugin from "./index.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const LIVE_MODEL_ID = process.env.OPENCLAW_LIVE_OPENAI_PLUGIN_MODEL?.trim() || "gpt-5.4-nano";
const liveEnabled = OPENAI_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

function createTemplateModel(modelId: string) {
  switch (modelId) {
    case "gpt-5.4":
      return {
        id: "gpt-5.2",
        name: "GPT-5.2",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400_000,
        maxTokens: 128_000,
      };
    case "gpt-5.4-mini":
      return {
        id: "gpt-5-mini",
        name: "GPT-5 mini",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400_000,
        maxTokens: 128_000,
      };
    case "gpt-5.4-nano":
      return {
        id: "gpt-5-nano",
        name: "GPT-5 nano",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      };
    default:
      throw new Error(`Unsupported live OpenAI plugin model: ${modelId}`);
  }
}

function registerOpenAIPlugin() {
  const providers: unknown[] = [];
  const speechProviders: unknown[] = [];
  const mediaProviders: unknown[] = [];
  const imageProviders: unknown[] = [];

  plugin.register(
    createTestPluginApi({
      id: "openai",
      name: "OpenAI Provider",
      source: "test",
      config: {},
      runtime: {} as never,
      registerProvider: (provider) => {
        providers.push(provider);
      },
      registerSpeechProvider: (provider) => {
        speechProviders.push(provider);
      },
      registerMediaUnderstandingProvider: (provider) => {
        mediaProviders.push(provider);
      },
      registerImageGenerationProvider: (provider) => {
        imageProviders.push(provider);
      },
    }),
  );

  return { providers, speechProviders, mediaProviders, imageProviders };
}

describe("openai plugin", () => {
  it("registers the expected provider surfaces", () => {
    const { providers, speechProviders, mediaProviders, imageProviders } = registerOpenAIPlugin();

    expect(providers).toHaveLength(2);
    expect(
      providers.map(
        (provider) =>
          // oxlint-disable-next-line typescript/no-explicit-any
          (provider as any).id,
      ),
    ).toEqual(["openai", "openai-codex"]);
    expect(speechProviders).toHaveLength(1);
    expect(mediaProviders).toHaveLength(1);
    expect(imageProviders).toHaveLength(1);
  });
});

describeLive("openai plugin live", () => {
  it("registers an OpenAI provider that can complete a live request", async () => {
    const { providers } = registerOpenAIPlugin();
    const provider =
      // oxlint-disable-next-line typescript/no-explicit-any
      providers.find((entry) => (entry as any).id === "openai");

    expect(provider).toBeDefined();

    // oxlint-disable-next-line typescript/no-explicit-any
    const resolved = (provider as any).resolveDynamicModel?.({
      provider: "openai",
      modelId: LIVE_MODEL_ID,
      modelRegistry: {
        find(providerId: string, id: string) {
          if (providerId !== "openai") {
            return null;
          }
          const template = createTemplateModel(LIVE_MODEL_ID);
          return id === template.id ? template : null;
        },
      },
    });

    expect(resolved).toBeDefined();

    // oxlint-disable-next-line typescript/no-explicit-any
    const normalized = (provider as any).normalizeResolvedModel?.({
      provider: "openai",
      modelId: resolved.id,
      model: resolved,
    });

    expect(normalized).toMatchObject({
      provider: "openai",
      id: LIVE_MODEL_ID,
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });

    const client = new OpenAI({
      apiKey: OPENAI_API_KEY,
      baseURL: normalized?.baseUrl,
    });
    const response = await client.responses.create({
      model: normalized?.id ?? LIVE_MODEL_ID,
      input: "Reply with exactly OK.",
      max_output_tokens: 16,
    });

    expect(response.output_text.trim()).toMatch(/^OK[.!]?$/);
  }, 30_000);
});
