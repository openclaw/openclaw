import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS } from "./api.js";
import plugin from "./index.js";
import {
  DOUBAO_CODING_MODEL_CATALOG,
  DOUBAO_MODEL_CATALOG,
  VOLCENGINE_PROVIDER_CATALOG,
} from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("volcengine plugin", () => {
  it("preserves both provider-owned static catalogs and paired ordering", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    expect([provider.catalog?.order, provider.staticCatalog?.order]).toEqual(["paired", "paired"]);
    expect(await provider.staticCatalog?.run({} as never)).toEqual({
      providers: Object.fromEntries(
        VOLCENGINE_PROVIDER_CATALOG.entries.map(({ id, buildProvider }) => [id, buildProvider()]),
      ),
    });
  });

  it("augments the catalog with bundled standard and plan models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    expect(provider.auth?.[0]?.starterModel).toBe("volcengine-plan/ark-code-latest");
    const entries = await provider.augmentModelCatalog?.({} as never);
    expect(entries).toEqual(
      [
        { provider: "volcengine", models: DOUBAO_MODEL_CATALOG },
        { provider: "volcengine-plan", models: DOUBAO_CODING_MODEL_CATALOG },
      ].flatMap(({ provider: providerId, models }) =>
        models.map(({ id, name, reasoning, input, contextWindow }) => ({
          provider: providerId,
          id,
          name,
          reasoning,
          input: [...input],
          contextWindow,
        })),
      ),
    );
    expect(DOUBAO_CODING_MODEL_CATALOG.map((entry) => entry.id)).toEqual([
      "ark-code-latest",
      "doubao-seed-2.1-turbo",
      "glm-5.2",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
    ]);
  });

  it("declares its coding provider auth alias in the manifest", () => {
    expect(manifest.providerAuthAliases).toEqual({ "volcengine-plan": "volcengine" });
  });

  it("declares OpenAI-compatible streaming usage support in the manifest", () => {
    const streaming = { openAICompletions: { supportsStreamingUsage: true } };
    expect(manifest.providerRequest.providers).toMatchObject({
      volcengine: streaming,
      "volcengine-plan": streaming,
    });
  });

  it("marks direct and coding models with tool schema keyword compat", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    expect(provider.hookAliases).toContain("volcengine-plan");
    const normalized = provider.normalizeResolvedModel?.({
      model: { compat: { unsupportedToolSchemaKeywords: ["not"] } },
    } as never);
    expect(normalized?.compat).toEqual({
      unsupportedToolSchemaKeywords: ["not", ...VOLCENGINE_UNSUPPORTED_TOOL_SCHEMA_KEYWORDS],
    });
    const normalizedAgain = provider.normalizeResolvedModel?.({ model: normalized } as never);
    expect(normalizedAgain).toBe(normalized);
  });
});
