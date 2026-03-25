import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/extensions/provider-registration.js";
import plugin from "./index.js";

const REQUESTY_API_KEY = process.env.REQUESTY_API_KEY ?? "";
const LIVE_MODEL_ID = process.env.OPENCLAW_LIVE_REQUESTY_PLUGIN_MODEL?.trim() || "openai/gpt-4o";
const liveEnabled = REQUESTY_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

const registerRequestyPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "requesty",
    name: "Requesty Provider",
  });

describe("requesty plugin", () => {
  it("registers the expected provider surfaces", () => {
    const { providers, speechProviders, mediaProviders, imageProviders } = registerRequestyPlugin();

    expect(providers).toHaveLength(1);
    expect(
      providers.map(
        (provider) =>
          // oxlint-disable-next-line typescript/no-explicit-any
          (provider as any).id,
      ),
    ).toEqual(["requesty"]);
    expect(speechProviders).toHaveLength(0);
    expect(mediaProviders).toHaveLength(0);
    expect(imageProviders).toHaveLength(0);
  });
});

describeLive("requesty plugin live", () => {
  it("registers a Requesty provider that can complete a live request", async () => {
    const { providers } = registerRequestyPlugin();
    const provider = requireRegisteredProvider(providers, "requesty");

    // oxlint-disable-next-line typescript/no-explicit-any
    const resolved = (provider as any).resolveDynamicModel?.({
      provider: "requesty",
      modelId: LIVE_MODEL_ID,
      modelRegistry: {
        find() {
          return null;
        },
      },
    });
    if (!resolved) {
      throw new Error(`requesty provider did not resolve ${LIVE_MODEL_ID}`);
    }

    expect(resolved).toMatchObject({
      provider: "requesty",
      id: LIVE_MODEL_ID,
      api: "openai-completions",
      baseUrl: "https://router.requesty.ai/v1",
    });

    const client = new OpenAI({
      apiKey: REQUESTY_API_KEY,
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
