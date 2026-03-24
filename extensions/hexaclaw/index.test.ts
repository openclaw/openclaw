import { describe, expect, it } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-wizard.js";
import { registerSingleProviderPlugin } from "../../test/helpers/extensions/plugin-registration.js";
import hexaclawPlugin from "./index.js";
import { applyHexaclawConfig } from "./onboard.js";

describe("hexaclaw provider plugin", () => {
  it("registers HexaClaw with api-key auth wizard metadata", () => {
    const provider = registerSingleProviderPlugin(hexaclawPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "hexaclaw-api-key",
    });

    expect(provider.id).toBe("hexaclaw");
    expect(provider.label).toBe("HexaClaw");
    expect(provider.envVars).toEqual(["HEXACLAW_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("hexaclaw");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("builds the static HexaClaw model catalog", async () => {
    const provider = registerSingleProviderPlugin(hexaclawPlugin);
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
    expect(catalog.provider.baseUrl).toBe("https://api.hexaclaw.com/v1");
    expect(catalog.provider.models?.length).toBeGreaterThan(5);
    expect(
      catalog.provider.models?.find((model) => model.id === "claude-sonnet-4-6"),
    ).toBeDefined();
    expect(
      catalog.provider.models?.find((model) => model.id === "deepseek-reasoner")?.reasoning,
    ).toBe(true);
    expect(catalog.provider.models?.find((model) => model.id === "o3")?.reasoning).toBe(true);
  });

  it("applies onboard config with primary model and provider entry", () => {
    const result = applyHexaclawConfig({});

    const model = result.agents?.defaults?.model;
    const primary = typeof model === "object" && model !== null ? model.primary : model;
    expect(primary).toBe("hexaclaw/claude-sonnet-4-6");
    expect(result.agents?.defaults?.models?.["hexaclaw/claude-sonnet-4-6"]?.alias).toBe("HexaClaw");
    expect(result.models?.providers?.hexaclaw).toBeDefined();
    expect(result.models?.providers?.hexaclaw?.api).toBe("openai-completions");
    expect(result.models?.providers?.hexaclaw?.baseUrl).toBe("https://api.hexaclaw.com/v1");
  });
});
