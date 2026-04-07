import { beforeEach, describe, expect, it, vi } from "vitest";

async function resetProviderRuntimeState() {
  const [
    { clearPluginManifestRegistryCache },
    { resetProviderRuntimeHookCacheForTest },
    { resetPluginLoaderTestStateForTest },
  ] = await Promise.all([
    import("../plugins/manifest-registry.js"),
    import("../plugins/provider-runtime.js"),
    import("../plugins/loader.test-fixtures.js"),
  ]);
  resetPluginLoaderTestStateForTest();
  clearPluginManifestRegistryCache();
  resetProviderRuntimeHookCacheForTest();
}

async function loadSecretsModule() {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../plugins/provider-runtime.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  vi.resetModules();
  await resetProviderRuntimeState();
  return import("./models-config.providers.secrets.js");
}

beforeEach(async () => {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../plugins/provider-runtime.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  vi.resetModules();
  await resetProviderRuntimeState();
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
