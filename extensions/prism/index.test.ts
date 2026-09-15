// Prism tests cover index plugin behavior.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("prism provider plugin", () => {
  it("registers Prism as an OpenAI-compatible provider", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("prism");
    expect(provider.envVars).toEqual(["PRISM_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);
    expect(provider.auth?.[0]?.starterModel).toBe("prism/deepseek-v4.1-flash");

    const result = await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({}),
    } as never);
    const catalogProvider = result && "provider" in result ? result.provider : undefined;

    expect(catalogProvider?.baseUrl).toBe("https://api.prisminference.com/v1");
    expect(catalogProvider?.api).toBe("openai-completions");
    expect(catalogProvider?.models?.map((model) => model.id)).toEqual([
      "deepseek-v4.1-flash",
      "deepseek-v4-flash",
    ]);
  });
});
