import { describe, expect, it } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import arceePlugin from "./index.js";

describe("arcee provider plugin", () => {
  it("registers Arcee AI with direct and OpenRouter auth choices", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);

    expect(provider.id).toBe("arcee");
    expect(provider.label).toBe("Arcee AI");
    expect(provider.envVars).toEqual(["ARCEEAI_API_KEY", "OPENROUTER_API_KEY"]);
    expect(provider.auth).toHaveLength(2);

    const directChoice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "arceeai-api-key",
    });
    expect(directChoice).not.toBeNull();
    expect(directChoice?.provider.id).toBe("arcee");
    expect(directChoice?.method.id).toBe("arcee-platform");

    const orChoice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "arceeai-openrouter",
    });
    expect(orChoice).not.toBeNull();
    expect(orChoice?.provider.id).toBe("arcee");
    expect(orChoice?.method.id).toBe("openrouter");
  });

  it("builds the direct Arcee AI model catalog", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);
    expect(provider.catalog).toBeDefined();

    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: (id: string) =>
        id === "arcee" ? { apiKey: "test-key" } : { apiKey: undefined },
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
  });

  it("builds the OpenRouter-backed Arcee AI model catalog", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);

    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: (id: string) =>
        id === "openrouter" ? { apiKey: "sk-or-test" } : { apiKey: undefined },
      resolveProviderAuth: () => ({
        apiKey: "sk-or-test",
        mode: "api_key",
        source: "env",
      }),
    } as never);

    expect(catalog && "provider" in catalog).toBe(true);
    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected single-provider catalog");
    }

    expect(catalog.provider.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(catalog.provider.models?.map((model) => model.id)).toEqual([
      "trinity-mini",
      "trinity-large-preview",
      "trinity-large-thinking",
    ]);
  });
});
