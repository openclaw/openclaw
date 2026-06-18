// CoreWeave tests cover catalog auth gating and the optional project header.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import {
  coreweaveModelRowsCacheKey,
  COREWEAVE_BASE_URL,
  COREWEAVE_DEFAULT_MODEL_REF,
  COREWEAVE_MODEL_CATALOG,
} from "./models.js";

type CatalogCtx = {
  config: unknown;
  resolveProviderApiKey: () => { apiKey: string | undefined };
};

// ProviderCatalogResult is a union; narrow to the single-provider variant.
function readProvider(result: unknown) {
  return result && typeof result === "object" && "provider" in result
    ? (result as { provider: ModelProviderConfig }).provider
    : null;
}

async function runLiveCatalog(ctx: CatalogCtx): Promise<ModelProviderConfig | null> {
  const registered = await registerSingleProviderPlugin(plugin);
  return readProvider(await registered.catalog?.run(ctx as never));
}

describe("coreweave provider plugin", () => {
  it("returns null catalog when no API key is available", async () => {
    const provider = await runLiveCatalog({
      config: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
    });
    expect(provider).toBeNull();
  });

  it("returns the static catalog with the resolved API key when a key is present", async () => {
    const provider = await runLiveCatalog({
      config: {},
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
    });
    expect(provider?.baseUrl).toBe(COREWEAVE_BASE_URL);
    expect(provider?.apiKey).toBe("test-key");
    expect(provider?.models?.length ?? 0).toBeGreaterThan(0);
    expect(provider?.headers).toBeUndefined();
  });

  it("attaches the openai-project header when the plugin project config is set", async () => {
    const provider = await runLiveCatalog({
      config: {
        plugins: { entries: { coreweave: { config: { project: "my-team/my-project" } } } },
      },
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
    });
    expect(provider?.headers).toEqual({ "openai-project": "my-team/my-project" });
  });

  it("keeps the default model ref pointing at a real catalog row", () => {
    const defaultId = COREWEAVE_DEFAULT_MODEL_REF.replace(/^coreweave\//, "");
    expect(COREWEAVE_MODEL_CATALOG.some((m) => m.id === defaultId)).toBe(true);
  });

  it("exposes a static catalog for credential-free discovery", async () => {
    const registered = await registerSingleProviderPlugin(plugin);
    const provider = readProvider(await registered.staticCatalog?.run({ config: {} } as never));
    expect(provider?.models?.length ?? 0).toBeGreaterThan(0);
  });

  it("scopes the discovery cache by credential and project", () => {
    const keyA = coreweaveModelRowsCacheKey({ apiKey: "key-a", project: "team/p1" });
    // Different credential and different project must not reuse a cached row set.
    expect(coreweaveModelRowsCacheKey({ apiKey: "key-b", project: "team/p1" })).not.toEqual(keyA);
    expect(coreweaveModelRowsCacheKey({ apiKey: "key-a", project: "team/p2" })).not.toEqual(keyA);
    // Distinct credentials must not collapse onto a shared anon/auth marker.
    expect(coreweaveModelRowsCacheKey({})).not.toEqual(
      coreweaveModelRowsCacheKey({ apiKey: "key-a" }),
    );
    // Identical inputs are stable so the TTL cache still hits.
    expect(coreweaveModelRowsCacheKey({ apiKey: "key-a", project: "team/p1" })).toEqual(keyA);
  });
});
