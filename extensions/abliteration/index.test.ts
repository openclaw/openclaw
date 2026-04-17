import { describe, expect, it } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import abliterationPlugin from "./index.js";

describe("abliteration provider plugin", () => {
  it("registers Abliteration with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(abliterationPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "abliteration-api-key",
    });

    expect(provider.id).toBe("abliteration");
    expect(provider.label).toBe("Abliteration");
    expect(provider.envVars).toEqual(["ABLITERATION_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("abliteration");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("builds the static Abliteration model catalog", async () => {
    const provider = await registerSingleProviderPlugin(abliterationPlugin);
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

    expect(catalog.provider.api).toBe("anthropic-messages");
    expect(catalog.provider.baseUrl).toBe("https://api.abliteration.ai");
    expect(catalog.provider.models?.map((model) => model.id)).toEqual(["abliterated-model"]);
    expect(catalog.provider.models?.[0]).toMatchObject({
      cost: {
        input: 5,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
      },
      input: ["text", "image"],
      maxTokens: 8192,
      contextWindow: 128000,
    });
  });
});
