import { getEmbeddingProvider } from "openclaw/plugin-sdk/embedding-providers";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, assert, expect, it } from "vitest";
import { geminiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

it("resolves google without changing the Gemini index identity", async () => {
  expect(geminiMemoryEmbeddingProviderAdapter.aliases).toContain("google");
  const registry = createEmptyPluginRegistry();
  registry.embeddingProviders.push({
    pluginId: "google",
    provider: geminiMemoryEmbeddingProviderAdapter,
    source: "test",
  });
  setActivePluginRegistry(registry);
  const config = {};
  const alias = getEmbeddingProvider("google", config);
  const canonical = getEmbeddingProvider("gemini", config);
  assert(alias, "google must resolve to the Gemini embedding adapter");
  assert(canonical);
  expect(alias).toBe(canonical);
  const options = {
    config,
    model: "gemini-embedding-001",
    remote: { apiKey: "synthetic-google-alias-key" },
  };
  const google = await alias.create({ ...options, provider: "google" });
  const gemini = await canonical.create({ ...options, provider: "gemini" });
  expect(google.provider?.id).toBe("gemini");
  expect(google.runtime?.id).toBe("gemini");
  expect(google.runtime?.cacheKeyData).toEqual(gemini.runtime?.cacheKeyData);
});
