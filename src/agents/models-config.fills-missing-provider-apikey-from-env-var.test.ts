import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../plugins/manifest-registry.js");
vi.unmock("../plugins/provider-runtime.js");
vi.unmock("../plugins/provider-runtime.runtime.js");
vi.unmock("../secrets/provider-env-vars.js");

async function loadSecretsModule() {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../plugins/provider-runtime.js");
  vi.doUnmock("../plugins/provider-runtime.runtime.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  vi.resetModules();
  const [{ resetProviderRuntimeHookCacheForTest }, { resetPluginLoaderTestStateForTest }] =
    await Promise.all([
      import("../plugins/provider-runtime.js"),
      import("../plugins/loader.test-fixtures.js"),
    ]);
  resetPluginLoaderTestStateForTest();
  resetProviderRuntimeHookCacheForTest();
  return import("./models-config.providers.secrets.js");
}

beforeEach(async () => {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../plugins/provider-runtime.js");
  vi.doUnmock("../plugins/provider-runtime.runtime.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  vi.resetModules();
  const [{ resetProviderRuntimeHookCacheForTest }, { resetPluginLoaderTestStateForTest }] =
    await Promise.all([
      import("../plugins/provider-runtime.js"),
      import("../plugins/loader.test-fixtures.js"),
    ]);
  resetPluginLoaderTestStateForTest();
  resetProviderRuntimeHookCacheForTest();
});

describe("models-config", () => {
  it("fills missing provider.apiKey from env var name when models exist", async () => {
    const { resolveMissingProviderApiKey } = await loadSecretsModule();
    const provider = resolveMissingProviderApiKey({
      providerKey: "minimax",
      provider: {
        baseUrl: "https://api.minimax.io/anthropic",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.7",
            name: "MiniMax M2.7",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
      env: { MINIMAX_API_KEY: "sk-minimax-test" } as NodeJS.ProcessEnv,
      profileApiKey: undefined,
    });

    expect(provider.apiKey).toBe("MINIMAX_API_KEY"); // pragma: allowlist secret
  });
});
