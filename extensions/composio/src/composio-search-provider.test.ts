import { describe, expect, it } from "vitest";
import { createComposioWebSearchProvider } from "./composio-search-provider.js";

describe("composio web search provider", () => {
  it("registers setup-visible credential metadata", () => {
    const provider = createComposioWebSearchProvider();
    const config = {};
    const applied = provider.applySelectionConfig?.(config as never) as {
      plugins?: { entries?: { composio?: { enabled?: boolean } } };
    };

    expect(provider.id).toBe("composio");
    expect(provider.credentialPath).toBe("plugins.entries.composio.config.webSearch.apiKey");
    expect(provider.envVars).toEqual(["COMPOSIO_API_KEY"]);
    expect(provider.inactiveSecretPaths).toContain("tools.web.search.composioApiKey");
    expect(applied.plugins?.entries?.composio?.enabled).toBe(true);
  });

  it("stores configured credentials in plugin webSearch config", () => {
    const provider = createComposioWebSearchProvider();
    const config = {};

    provider.setConfiguredCredentialValue?.(config as never, "ak_test");

    expect(provider.getConfiguredCredentialValue?.(config as never)).toBe("ak_test");
    expect(config).toEqual({
      plugins: {
        entries: {
          composio: {
            enabled: true,
            config: {
              webSearch: {
                apiKey: "ak_test",
              },
            },
          },
        },
      },
    });
  });
});
