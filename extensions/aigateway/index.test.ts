// AIgateway tests cover index plugin behavior.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

function requireCatalogProvider(
  result:
    | { provider: { baseUrl?: string; models?: Array<{ id: string; api?: string }> } }
    | { providers: Record<string, unknown> }
    | null
    | undefined,
): { baseUrl?: string; models?: Array<{ id: string; api?: string }> } {
  if (!result || !("provider" in result)) {
    throw new Error("single provider catalog result missing");
  }
  return result.provider;
}

describe("aigateway provider plugin", () => {
  it("registers AIgateway as an OpenAI-compatible provider", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("aigateway");
    expect(provider.envVars).toEqual(["AIGATEWAY_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);

    const result = await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({}),
    } as never);
    const catalogProvider = requireCatalogProvider(result);
    expect(catalogProvider.baseUrl).toBe("https://api.aigateway.sh/v1");
    expect(catalogProvider.models?.map((model) => model.id)).toContain("openai/gpt-5.5");
    expect(catalogProvider.models?.every((model) => model.api === "openai-completions")).toBe(true);
  });
});
