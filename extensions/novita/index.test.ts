// Novita tests cover index plugin behavior.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

function requireCatalogProvider(
  result:
    | { provider: { baseUrl?: string; models?: Array<{ id: string }> } }
    | { providers: Record<string, unknown> }
    | null
    | undefined,
): { baseUrl?: string; models?: Array<{ id: string }> } {
  if (!result || !("provider" in result)) {
    throw new Error("single provider catalog result missing");
  }
  return result.provider;
}

describe("novita provider plugin", () => {
  it("registers NovitaAI as an OpenAI-compatible provider", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("novita");
    expect(provider.aliases).toEqual(["novita-ai", "novitaai"]);
    expect(provider.envVars).toEqual(["NOVITA_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);

    const result = await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({}),
    } as never);
    const catalogProvider = requireCatalogProvider(result);
    expect(catalogProvider.baseUrl).toBe("https://api.novita.ai/openai/v1");
    expect(catalogProvider.models?.map((model) => model.id)).toContain("deepseek/deepseek-v3-0324");
  });

  // planManifestModelCatalogRows sets entry.discovery from
  // modelCatalog.discovery[provider]. The static-authoritative filter at
  // src/commands/models/list.manifest-catalog.ts:45 and the bundled
  // static-catalog resolver at
  // src/agents/embedded-agent-runner/model.static-catalog.ts:239 only
  // accept entries with discovery === "static". Without this declaration,
  // every other OpenAI-compatible sibling (anthropic, cerebras, mistral,
  // together, volcengine, byteplus, cohere, ...) qualifies; Novita alone
  // is filtered out.
  it("registers discovery mode so the manifest catalog planner accepts Novita rows", () => {
    expect(manifest.modelCatalog?.discovery?.novita).toBe("static");
  });
});
