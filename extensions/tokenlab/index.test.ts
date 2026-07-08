// TokenLab tests cover index plugin behavior.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

function requireCatalogProvider(
  result:
    | {
        provider: {
          baseUrl?: string;
          models?: Array<{ id: string; compat?: { supportsTools?: boolean } }>;
        };
      }
    | { providers: Record<string, unknown> }
    | null
    | undefined,
): { baseUrl?: string; models?: Array<{ id: string; compat?: { supportsTools?: boolean } }> } {
  if (!result || !("provider" in result)) {
    throw new Error("single provider catalog result missing");
  }
  return result.provider;
}

describe("tokenlab provider plugin", () => {
  it("registers TokenLab as an OpenAI-compatible provider", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("tokenlab");
    expect(provider.label).toBe("TokenLab");
    expect(provider.envVars).toEqual(["TOKENLAB_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);

    const result = await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({}),
    } as never);
    const catalogProvider = requireCatalogProvider(result);
    expect(catalogProvider.baseUrl).toBe("https://api.tokenlab.sh/v1");
    expect(catalogProvider.models?.map((model) => model.id)).toContain("gpt-5.5");
    expect(catalogProvider.models?.map((model) => model.id)).toContain("qwen3.7-max");
    expect(
      catalogProvider.models?.find((model) => model.id === "qwen3.7-max")?.compat?.supportsTools,
    ).toBe(false);
  });
});
