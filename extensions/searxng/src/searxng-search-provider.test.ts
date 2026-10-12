import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSearxngBaseUrl } from "./config.js";

const { runSearxngSearch } = vi.hoisted(() => ({
  runSearxngSearch: vi.fn(async (params: Record<string, unknown>) => params),
}));

vi.mock("./searxng-client.js", () => ({
  runSearxngSearch,
}));

function configWithBaseUrl(baseUrl: unknown): OpenClawConfig {
  return { plugins: { entries: { searxng: { config: { webSearch: { baseUrl } } } } } };
}

describe("searxng web search provider", () => {
  let createSearxngWebSearchProvider: typeof import("./searxng-search-provider.js").createSearxngWebSearchProvider;
  let plugin: typeof import("../index.js").default;

  beforeAll(async () => {
    ({ createSearxngWebSearchProvider } = await import("./searxng-search-provider.js"));
    ({ default: plugin } = await import("../index.js"));
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    runSearxngSearch.mockReset();
    runSearxngSearch.mockImplementation(async (params: Record<string, unknown>) => params);
  });

  function createTool() {
    return expectDefined(
      createSearxngWebSearchProvider().createTool({ config: {} }),
      "SearXNG search tool",
    );
  }

  it("registers a setup-visible web search provider", () => {
    const webSearchProviders: unknown[] = [];

    plugin.register({
      registerWebSearchProvider(provider: unknown) {
        webSearchProviders.push(provider);
      },
    } as never);

    expect(plugin.id).toBe("searxng");
    expect(webSearchProviders).toEqual([
      expect.objectContaining({
        id: "searxng",
        requiresCredential: true,
        envVars: ["SEARXNG_BASE_URL"],
        onboardingScopes: ["text-inference"],
      }),
    ]);
  });

  it("enables the plugin in config when selected", () => {
    const provider = createSearxngWebSearchProvider();
    const applied = expectDefined(provider.applySelectionConfig, "selection handler")({});

    expect(provider.credentialPath).toBe("plugins.entries.searxng.config.webSearch.baseUrl");
    expect(applied.plugins?.entries?.searxng?.enabled).toBe(true);
  });

  it("maps generic tool arguments into SearXNG search params", async () => {
    await createTool().execute({
      query: "openclaw docs",
      count: 4,
      categories: "general,news",
      language: "en",
    });

    expect(runSearxngSearch).toHaveBeenCalledWith({
      config: {},
      query: "openclaw docs",
      count: 4,
      categories: "general,news",
      language: "en",
    });
  });

  it("rejects fractional and out-of-range counts before searching", async () => {
    const tool = createTool();

    await expect(tool.execute({ query: "openclaw docs", count: 4.5 })).rejects.toThrow(
      "count must be an integer from 1 to 10.",
    );
    await expect(tool.execute({ query: "openclaw docs", count: 11 })).rejects.toThrow(
      "count must be an integer from 1 to 10.",
    );
    expect(runSearxngSearch).not.toHaveBeenCalled();
  });

  it("reads base URL from plugin config SecretRef, then env var, stripping trailing slashes", () => {
    vi.stubEnv("SEARXNG_BASE_URL", "http://localhost:8888/");
    expect(
      resolveSearxngBaseUrl(
        configWithBaseUrl({
          source: "env",
          provider: "default",
          id: "SEARXNG_BASE_URL",
        }),
      ),
    ).toBe("http://localhost:8888");

    vi.stubEnv("SEARXNG_BASE_URL", "https://search.local/searxng///");
    expect(resolveSearxngBaseUrl({})).toBe("https://search.local/searxng");

    vi.stubEnv("SEARXNG_BASE_URL", "");
    expect(resolveSearxngBaseUrl({})).toBeUndefined();
  });

  it("does not fall back to ambient env when an explicit SecretRef is blocked", () => {
    vi.stubEnv("SEARXNG_BASE_URL", "https://ambient.example/");
    const config: OpenClawConfig = {
      ...configWithBaseUrl({ source: "env", provider: "restricted", id: "SEARXNG_BASE_URL" }),
      secrets: {
        providers: {
          restricted: {
            source: "env",
            allowlist: [],
          },
        },
      },
    };

    expect(resolveSearxngBaseUrl(config)).toBeUndefined();
  });

  it("persists base URL to plugin config via setConfiguredCredentialValue", () => {
    const provider = createSearxngWebSearchProvider();
    const config: OpenClawConfig = {};
    expectDefined(provider.setConfiguredCredentialValue, "credential setter")(
      config,
      "http://search.local:9000",
    );

    expect(resolveSearxngBaseUrl(config)).toBe("http://search.local:9000");
  });
});
