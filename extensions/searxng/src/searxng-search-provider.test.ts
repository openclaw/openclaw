import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { createSearxngWebSearchProvider } from "./searxng-search-provider.js";

const { runSearxngSearch } = vi.hoisted(() => ({
  runSearxngSearch: vi.fn(async (params: Record<string, unknown>) => params),
}));

// mock-isolation: Provider argument mapping must not execute real search requests.
vi.mock("./searxng-client.js", () => ({ runSearxngSearch }));

describe("searxng web search provider", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    runSearxngSearch
      .mockReset()
      .mockImplementation(async (params: Record<string, unknown>) => params);
  });

  function createTool() {
    return expectDefined(
      createSearxngWebSearchProvider().createTool({ config: {} }),
      "SearXNG search tool",
    );
  }

  it("registers a setup-visible web search provider", () => {
    const registerWebSearchProvider = vi.fn();
    plugin.register({ registerWebSearchProvider } as never);
    expect(plugin.id).toBe("searxng");
    expect(registerWebSearchProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: "searxng",
        requiresCredential: true,
        envVars: ["SEARXNG_BASE_URL"],
        onboardingScopes: ["text-inference"],
      }),
    );
  });

  it("maps generic tool arguments into SearXNG search params", async () => {
    const args = { query: "openclaw docs", count: 4, categories: "general,news", language: "en" };
    await createTool().execute(args);
    expect(runSearxngSearch).toHaveBeenCalledWith({ config: {}, ...args });
  });

  it.each([4.5, 11])("rejects invalid count %s before searching", async (count) => {
    await expect(createTool().execute({ query: "openclaw docs", count })).rejects.toThrow(
      "count must be an integer from 1 to 10.",
    );
    expect(runSearxngSearch).not.toHaveBeenCalled();
  });

  it("persists base URL to plugin config via setConfiguredCredentialValue", () => {
    const provider = createSearxngWebSearchProvider();
    const config: OpenClawConfig = {};
    expectDefined(provider.setConfiguredCredentialValue, "credential setter")(
      config,
      "http://search.local:9000",
    );

    expect(config.plugins?.entries?.searxng?.config?.webSearch).toEqual({
      baseUrl: "http://search.local:9000",
    });
  });
});
