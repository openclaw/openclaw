// Novita tests cover index plugin behavior.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import plugin from "./index.js";

describe("novita provider plugin", () => {
  it("registers NovitaAI as an OpenAI-compatible provider", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("novita");
    expect(provider.aliases).toEqual(["novita-ai", "novitaai"]);
    expect(provider.envVars).toEqual(["NOVITA_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);
    expect(provider.auth?.[0]?.starterModel).toBe("novita/deepseek/deepseek-v4-pro");

    const catalogProvider = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
    expect(catalogProvider?.baseUrl).toBe("https://api.novita.ai/openai/v1");
    expect(catalogProvider?.models?.map((model) => model.id)).toContain("deepseek/deepseek-v4-pro");
  });
});
