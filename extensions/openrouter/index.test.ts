import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { createTestPluginApi } from "../../test/helpers/extensions/plugin-api.js";
import plugin from "./index.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const LIVE_MODEL_ID =
  process.env.OPENCLAW_LIVE_OPENROUTER_PLUGIN_MODEL?.trim() || "openai/gpt-5.4-nano";
const liveEnabled = OPENROUTER_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

function registerOpenRouterPlugin() {
  const providers: unknown[] = [];
  const speechProviders: unknown[] = [];
  const mediaProviders: unknown[] = [];
  const imageProviders: unknown[] = [];

  plugin.register(
    createTestPluginApi({
      id: "openrouter",
      name: "OpenRouter Provider",
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

describe("openrouter plugin", () => {
  it("registers the expected provider surfaces", () => {
    const { providers, speechProviders, mediaProviders, imageProviders } =
      registerOpenRouterPlugin();

    expect(providers).toHaveLength(1);
    expect(
      providers.map(
        (provider) =>
          // oxlint-disable-next-line typescript/no-explicit-any
          (provider as any).id,
      ),
    ).toEqual(["openrouter"]);
    expect(speechProviders).toHaveLength(0);
    expect(mediaProviders).toHaveLength(0);
    expect(imageProviders).toHaveLength(0);
  });
});

describeLive("openrouter plugin live", () => {
  it("registers an OpenRouter provider that can complete a live request", async () => {
    const { providers } = registerOpenRouterPlugin();
    const provider =
      // oxlint-disable-next-line typescript/no-explicit-any
      providers.find((entry) => (entry as any).id === "openrouter");
    if (!provider) {
      throw new Error("openrouter provider was not registered");
    }

    // oxlint-disable-next-line typescript/no-explicit-any
    const resolved = (provider as any).resolveDynamicModel?.({
      provider: "openrouter",
      modelId: LIVE_MODEL_ID,
      modelRegistry: {
        find() {
          return null;
        },
      },
    });
    if (!resolved) {
      throw new Error(`openrouter provider did not resolve ${LIVE_MODEL_ID}`);
    }

    expect(resolved).toMatchObject({
      provider: "openrouter",
      id: LIVE_MODEL_ID,
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    const client = new OpenAI({
      apiKey: OPENROUTER_API_KEY,
      baseURL: resolved.baseUrl,
    });
    const response = await client.chat.completions.create({
      model: resolved.id,
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      max_tokens: 16,
    });

    expect(response.choices[0]?.message?.content?.trim()).toMatch(/^OK[.!]?$/);
  }, 30_000);
});
