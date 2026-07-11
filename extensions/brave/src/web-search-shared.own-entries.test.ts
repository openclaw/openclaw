// Brave credential own-property checks: Object.hasOwn() vs `in`
// These tests verify that inherited prototype properties on the legacy
// tools.web.search config object are not mistaken for explicit user credentials,
// and that the primary credential reader also rejects proto-inherited entries.
import { describe, expect, it } from "vitest";
import { buildBraveWebSearchProviderBase } from "../web-search-shared.js";

describe("brave credential own-property checks", () => {
  const base = buildBraveWebSearchProviderBase();
  const credentialReader = base.getConfiguredCredentialValue!;
  const fallbackReader = base.getConfiguredCredentialFallback!;

  describe("primary credential reader (plugin config first)", () => {
    it("ignores proto-inherited apiKey via plugin config", () => {
      const pluginEntry = Object.create({ webSearch: { apiKey: "proto-plugin-key" } });
      pluginEntry.config = { unrelated: "value" };
      const cfg = { plugins: { entries: { brave: pluginEntry } } };

      const result = credentialReader(cfg);
      expect(result).toBeUndefined();
    });

    it("reads own plugin config apiKey", () => {
      const cfg = {
        plugins: {
          entries: {
            brave: {
              config: {
                webSearch: { apiKey: "own-plugin-key" },
              },
            },
          },
        },
      };

      expect(credentialReader(cfg)).toBe("own-plugin-key");
    });

    it("falls through to legacy search when no plugin config", () => {
      const search = Object.create({ apiKey: "proto-legacy-key" });
      const cfg = { tools: { web: { search } } };

      // Proto-inherited legacy key must be rejected even in fallback
      expect(credentialReader(cfg)).toBeUndefined();
    });

    it("reads own legacy apiKey when no plugin config", () => {
      const cfg = { tools: { web: { search: { apiKey: "own-legacy-key" } } } };
      expect(credentialReader(cfg)).toBe("own-legacy-key");
    });
  });

  describe("legacy fallback credential reader", () => {
    it("ignores proto-inherited apiKey from tools.web.search", () => {
      const search = Object.create({ apiKey: "proto-search-key" });
      search.irrelevantOwnField = "yes";

      const result = fallbackReader({
        tools: { web: { search } },
      });

      // Object.hasOwn(search, "apiKey") returns false → inherited value rejected
      expect(result).toBeUndefined();
    });

    it("reads own apiKey from tools.web.search", () => {
      const result = fallbackReader({
        tools: {
          web: {
            search: { apiKey: "own-search-key" },
          },
        },
      });

      expect(result).toEqual({
        path: "tools.web.search.apiKey",
        value: "own-search-key",
      });
    });

    it("returns undefined when tools.web.search has no apiKey", () => {
      const result = fallbackReader({
        tools: {
          web: {
            search: { someOtherKey: "irrelevant" },
          },
        },
      });

      expect(result).toBeUndefined();
    });

    it("returns undefined when tools.web.search is missing entirely", () => {
      const result = fallbackReader({ tools: { web: {} } });
      expect(result).toBeUndefined();
    });
  });

  describe("canonical plugin config inheritance", () => {
    // The canonical Brave credential path is:
    //   plugins.entries.brave.config.webSearch.apiKey (primary)
    //   tools.web.search.apiKey (legacy fallback)
    // Object.hasOwn() protects against proto-inherited apiKey at the final
    // extraction level in both paths.

    it("rejects proto-inherited apiKey on plugin webSearch object", () => {
      // apiKey is on the webSearch object's prototype; the primary reader
      // uses Object.hasOwn(pluginConfig, "apiKey") to reject it.
      const webSearch = Object.create({ apiKey: "proto-api-key" });
      const cfg = { plugins: { entries: { brave: { config: { webSearch } } } } };
      expect(credentialReader(cfg)).toBeUndefined();
    });

    it("reads own apiKey from plugin webSearch object (backward compat)", () => {
      const cfg = {
        plugins: {
          entries: {
            brave: {
              config: {
                webSearch: { apiKey: "canonical-plugin-key" },
              },
            },
          },
        },
      };
      expect(credentialReader(cfg)).toBe("canonical-plugin-key");
    });

    it("plugin config takes precedence over legacy with own values", () => {
      const cfg = {
        plugins: {
          entries: {
            brave: {
              config: {
                webSearch: { apiKey: "plugin-precedence-key" },
              },
            },
          },
        },
        tools: {
          web: {
            search: { apiKey: "legacy-key" },
          },
        },
      };
      expect(credentialReader(cfg)).toBe("plugin-precedence-key");
    });

    it("falls through to legacy with own apiKey when plugin config has no apiKey", () => {
      const cfg = {
        plugins: {
          entries: {
            brave: {
              config: {
                webSearch: { unrelatedOption: "value" },
              },
            },
          },
        },
        tools: {
          web: {
            search: { apiKey: "fallback-legacy-key" },
          },
        },
      };
      expect(credentialReader(cfg)).toBe("fallback-legacy-key");
    });
  });
});
