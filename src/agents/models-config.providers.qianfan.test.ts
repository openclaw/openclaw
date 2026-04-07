import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import { resetProviderRuntimeHookCacheForTest } from "../plugins/provider-runtime.js";

async function loadSecretsModule() {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../plugins/provider-runtime.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  clearPluginManifestRegistryCache();
  resetProviderRuntimeHookCacheForTest();
  vi.resetModules();
  return import("./models-config.providers.secrets.js");
}

beforeEach(() => {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../plugins/provider-runtime.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  clearPluginManifestRegistryCache();
  resetProviderRuntimeHookCacheForTest();
});

describe("Qianfan provider", () => {
  it("resolves QIANFAN_API_KEY markers through provider auth lookup", async () => {
    const { createProviderAuthResolver } = await loadSecretsModule();
    const resolveAuth = createProviderAuthResolver(
      {
        QIANFAN_API_KEY: "test-key", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      { version: 1, profiles: {} },
    );

    expect(resolveAuth("qianfan")).toMatchObject({
      apiKey: "QIANFAN_API_KEY",
      mode: "api_key",
      source: "env",
    });
  });
});
