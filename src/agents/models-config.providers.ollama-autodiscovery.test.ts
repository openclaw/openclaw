import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  normalizePluginDiscoveryResult,
  resolvePluginDiscoveryProviders,
  runProviderCatalog,
} from "../plugins/provider-discovery.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import type { ProviderConfig } from "./models-config.providers.js";

describe("Ollama auto-discovery", () => {
  let originalFetch: typeof globalThis.fetch;
  let ollamaCatalogProviderPromise: Promise<ProviderPlugin | undefined> | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
    delete process.env.OLLAMA_API_KEY;
  });

  function createCleanProviderDiscoveryEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    delete env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    delete env.OPENCLAW_SKIP_PROVIDERS;
    delete env.OPENCLAW_SKIP_CHANNELS;
    delete env.OPENCLAW_SKIP_CRON;
    delete env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    return env;
  }

  function createCatalogLoadEnv(): NodeJS.ProcessEnv {
    originalFetch = globalThis.fetch;
    return {
      ...createCleanProviderDiscoveryEnv(),
      OPENCLAW_TEST_ONLY_PROVIDER_PLUGIN_IDS: "ollama",
      VITEST: "1",
      NODE_ENV: "test",
    };
  }

  function createDiscoveryRunEnv(): NodeJS.ProcessEnv {
    return {
      ...createCleanProviderDiscoveryEnv(),
      OPENCLAW_TEST_ONLY_PROVIDER_PLUGIN_IDS: "ollama",
      VITEST: "",
      NODE_ENV: "development",
    };
  }

  async function loadOllamaCatalogProvider(): Promise<ProviderPlugin | undefined> {
    ollamaCatalogProviderPromise ??= resolvePluginDiscoveryProviders({
      env: createCatalogLoadEnv(),
      onlyPluginIds: ["ollama"],
    }).then((providers) => providers.find((provider) => provider.id === "ollama"));
    return ollamaCatalogProviderPromise;
  }

  async function runOllamaCatalog(params?: {
    explicitProviders?: Record<string, ProviderConfig>;
  }): Promise<ProviderConfig | undefined> {
    const provider = await loadOllamaCatalogProvider();
    if (!provider) {
      return undefined;
    }
    const env = createDiscoveryRunEnv();
    const config: OpenClawConfig | undefined = params?.explicitProviders
      ? { models: { providers: params.explicitProviders } }
      : undefined;
    const result = await runProviderCatalog({
      provider,
      config: config ?? {},
      agentDir: mkdtempSync(join(tmpdir(), "openclaw-test-")),
      env,
      resolveProviderApiKey: () => ({
        apiKey: env.OLLAMA_API_KEY?.trim() ? env.OLLAMA_API_KEY : undefined,
      }),
      resolveProviderAuth: () => ({
        apiKey: env.OLLAMA_API_KEY?.trim() ? env.OLLAMA_API_KEY : undefined,
        mode: env.OLLAMA_API_KEY?.trim() ? "api_key" : "none",
        source: env.OLLAMA_API_KEY?.trim() ? "env" : "none",
      }),
    });
    return normalizePluginDiscoveryResult({ provider, result }).ollama as
      | ProviderConfig
      | undefined;
  }

  function mockOllamaUnreachable() {
    globalThis.fetch = withFetchPreconnect(
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:11434")),
    ) as typeof fetch;
  }

  it("auto-registers ollama provider when models are discovered locally", async () => {
    globalThis.fetch = withFetchPreconnect(
      vi.fn().mockImplementation(async (url: string | URL) => {
        if (String(url).includes("/api/tags")) {
          return {
            ok: true,
            json: async () => ({
              models: [{ name: "deepseek-r1:latest" }, { name: "llama3.3:latest" }],
            }),
          };
        }
        if (String(url).includes("/api/show")) {
          return {
            ok: true,
            json: async () => ({ model_info: {} }),
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    ) as typeof fetch;

    const provider = await runOllamaCatalog();

    expect(provider).toBeDefined();
    expect(provider?.apiKey).toBe("ollama-local");
    expect(provider?.api).toBe("ollama");
    expect(provider?.baseUrl).toBe("http://127.0.0.1:11434");
    expect(provider?.models).toHaveLength(2);
    expect(provider?.models?.[0]?.id).toBe("deepseek-r1:latest");
    expect(provider?.models?.[0]?.reasoning).toBe(true);
    expect(provider?.models?.[1]?.reasoning).toBe(false);
  });

  it("does not warn when Ollama is unreachable and not explicitly configured", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockOllamaUnreachable();

    const provider = await runOllamaCatalog();

    expect(provider).toBeUndefined();
    const ollamaWarnings = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("Ollama"),
    );
    expect(ollamaWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("warns when Ollama is unreachable and explicitly configured", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockOllamaUnreachable();

    await runOllamaCatalog({
      explicitProviders: {
        ollama: {
          baseUrl: "http://127.0.0.1:11435/v1",
          api: "openai-completions",
          models: [],
        },
      },
    });

    const ollamaWarnings = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("Ollama"),
    );
    expect(ollamaWarnings.length).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });
});
