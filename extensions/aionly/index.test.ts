import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import aionlyPlugin from "./index.js";

describe("aionly provider plugin", () => {
  it("registers AIOnly with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(aionlyPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "aionly-api-key",
    });

    expect(provider.id).toBe("aionly");
    expect(provider.label).toBe("AIOnly");
    expect(provider.envVars).toEqual(["AIONLY_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    if (!resolved) {
      throw new Error("expected AIOnly api-key auth choice");
    }
    expect(resolved.provider.id).toBe("aionly");
    expect(resolved.method.id).toBe("api-key");
  });

  it("builds the static AIOnly model catalog", async () => {
    const provider = await registerSingleProviderPlugin(aionlyPlugin);
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://api.aionly.com/v1");
    expect(catalogProvider.models?.map((model) => model.id)).toEqual(["deepseek-v4-flash"]);
    const flashModel = catalogProvider.models?.find((model) => model.id === "deepseek-v4-flash");
    expect(flashModel?.reasoning).toBe(true);
    expect(flashModel?.contextWindow).toBe(1000000);
    expect(flashModel?.maxTokens).toBe(384000);
    expect(flashModel?.cost).toEqual({
      input: 0.14,
      output: 0.28,
      cacheRead: 0.0028,
      cacheWrite: 0,
    });
  });
});
