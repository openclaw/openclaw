import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import OpenAI from "openai";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

const EDENAI_API_KEY = process.env.EDENAI_API_KEY ?? "";
const LIVE_MODEL_ID =
  process.env.OPENCLAW_LIVE_EDENAI_PLUGIN_MODEL?.trim() || "google/gemini-2.5-flash-lite";
const liveEnabled = EDENAI_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;
const ModelRegistryCtor = ModelRegistry as unknown as {
  new (authStorage: AuthStorage, modelsJsonPath?: string): ModelRegistry;
};

const registerEdenaiPlugin = async () =>
  registerProviderPlugin({
    plugin,
    id: "edenai",
    name: "Eden AI Provider",
  });

describeLive("edenai plugin live", () => {
  it("registers an Eden AI provider that can complete a live request", async () => {
    const { providers } = await registerEdenaiPlugin();
    const provider = requireRegisteredProvider(providers, "edenai");

    const resolved = provider.resolveDynamicModel?.({
      provider: "edenai",
      modelId: LIVE_MODEL_ID,
      modelRegistry: new ModelRegistryCtor(AuthStorage.inMemory()),
    });
    if (!resolved) {
      throw new Error(`edenai provider did not resolve ${LIVE_MODEL_ID}`);
    }

    expect(resolved.provider).toBe("edenai");
    expect(resolved.id).toBe(LIVE_MODEL_ID);
    expect(resolved.api).toBe("openai-completions");
    expect(resolved.baseUrl).toBe("https://api.edenai.run/v3");

    const client = new OpenAI({
      apiKey: EDENAI_API_KEY,
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
