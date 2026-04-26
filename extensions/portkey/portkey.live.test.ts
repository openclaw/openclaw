import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import plugin from "./index.js";
import { PORTKEY_BASE_URL } from "./onboard.js";

const PORTKEY_API_KEY = process.env.PORTKEY_API_KEY ?? "";
const LIVE_MODEL_ID = process.env.OPENCLAW_LIVE_PORTKEY_PLUGIN_MODEL?.trim() || "claude-opus-4-6";
const liveEnabled = PORTKEY_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

const registerPortkeyPlugin = async () =>
  registerProviderPlugin({
    plugin,
    id: "portkey",
    name: "Portkey Provider",
  });

describeLive("portkey plugin live", () => {
  it("registers a Portkey provider and can complete a live chat request", async () => {
    const { providers } = await registerPortkeyPlugin();
    const provider = requireRegisteredProvider(providers, "portkey");

    expect(provider).toMatchObject({ id: "portkey" });

    const client = new OpenAI({
      apiKey: PORTKEY_API_KEY,
      baseURL: PORTKEY_BASE_URL,
      defaultHeaders: {
        "x-portkey-api-key": PORTKEY_API_KEY,
      },
    });
    const response = await client.chat.completions.create({
      model: LIVE_MODEL_ID,
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      max_tokens: 16,
    });

    console.log("Portkey response:", JSON.stringify(response, null, 2));

    expect(response.choices[0]?.message?.content?.trim()).toMatch(/^OK[.!]?$/);
  }, 30_000);

  it("generates an image through the registered image provider", async () => {
    const { imageProviders } = await registerPortkeyPlugin();
    const imageProvider = imageProviders.find((p) => p.id === "portkey");
    if (!imageProvider) {
      throw new Error("portkey image generation provider not registered");
    }

    expect(imageProvider.label).toBe("Portkey");
    expect(imageProvider.defaultModel).toBe("gpt-image-2");
    expect(imageProvider.capabilities.generate.maxCount).toBeGreaterThanOrEqual(1);
  }, 10_000);
});
