import { describe, expect, it } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-wizard.js";
import { registerSingleProviderPlugin } from "../../test/helpers/extensions/plugin-registration.js";
import erniePlugin from "./index.js";

describe("ernie provider plugin", () => {
  it("registers ERNIE with api-key auth wizard metadata", () => {
    const provider = registerSingleProviderPlugin(erniePlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "ernie-api-key",
    });

    expect(provider.id).toBe("ernie");
    expect(provider.label).toBe("ERNIE");
    expect(provider.envVars).toEqual(["ERNIE_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("ernie");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("builds the static ERNIE model catalog", async () => {
    const provider = registerSingleProviderPlugin(erniePlugin);
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
    expect(catalog.provider.baseUrl).toBe("https://qianfan.baidubce.com/v2");
    expect(catalog.provider.models?.map((model) => model.id)).toEqual([
      "ernie-5.0-thinking-preview",
    ]);
    expect(
      catalog.provider.models?.find((model) => model.id === "ernie-5.0-thinking-preview")
        ?.reasoning,
    ).toBe(true);
  });
});
