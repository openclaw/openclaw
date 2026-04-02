import { resolveProviderPluginChoice } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import chuiziPlugin from "./index.js";

describe("chuizi provider plugin", () => {
  it("registers Chuizi.AI with api-key auth wizard metadata", () => {
    const provider = registerSingleProviderPlugin(chuiziPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "chuizi-api-key",
    });

    expect(provider.id).toBe("chuizi");
    expect(provider.label).toBe("Chuizi.AI");
    expect(provider.envVars).toEqual(["CHUIZI_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("chuizi");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("builds the static Chuizi.AI model catalog", async () => {
    const provider = registerSingleProviderPlugin(chuiziPlugin);
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
    expect(catalog.provider.baseUrl).toBe("https://api.chuizi.ai/v1");
    expect(catalog.provider.models?.map((model) => model.id)).toContain(
      "anthropic/claude-sonnet-4-6",
    );
    expect(
      catalog.provider.models?.find((model) => model.id === "anthropic/claude-opus-4-6")?.reasoning,
    ).toBe(true);
  });
});
