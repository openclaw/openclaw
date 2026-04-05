import { describe, expect, it } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import arceePlugin from "./index.js";

describe("arcee provider plugin", () => {
  it("registers Arcee AI with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "arceeai-api-key",
    });

    expect(provider.id).toBe("arcee");
    expect(provider.label).toBe("Arcee AI");
    expect(provider.envVars).toEqual(["ARCEEAI_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("arcee");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("builds the static Arcee AI model catalog", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);
    expect(provider.catalog).toBeDefined();

    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      resolveProviderAuth: () => ({
        apiKey: "test-key",
        mode: "api_key",
        source: "env",
      }),
    } as never);

    expect(catalog && "provider" in catalog).toBe(true);
    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected single-provider catalog");
    }

    expect(catalog.provider.api).toBe("openai-completions");
    expect(catalog.provider.baseUrl).toBe("https://api.arcee.ai/api/v1");
    expect(catalog.provider.models?.map((model) => model.id)).toEqual([
      "trinity-mini",
      "trinity-large-preview",
      "trinity-large-thinking",
    ]);
    expect(
      catalog.provider.models?.find((model) => model.id === "trinity-large-thinking")?.reasoning,
    ).toBe(true);
    expect(
      catalog.provider.models?.find((model) => model.id === "trinity-large-thinking")
        ?.contextWindow,
    ).toBe(262144);
  });
});
