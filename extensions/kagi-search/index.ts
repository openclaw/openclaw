/**
 * Example Kagi Search Provider Plugin for Clawdbot
 * Demonstrates how to register a custom search provider.
 */

import type { OpenClawPluginModule } from "openclaw/plugin-sdk";

const plugin: OpenClawPluginModule = {
  id: "kagi-search",
  name: "Kagi Search Provider",
  description: "Add Kagi as a web_search provider",
  version: "1.0.0",

  register(api) {
    api.registerSearchProvider({
      id: "kagi",
      label: "Kagi Search",
      description: "Privacy-focused search engine with high-quality results",

      async search(params, ctx) {
        // Get API key from plugin config or environment
        const pluginConfig = ctx.pluginConfig as { apiKey?: string } | undefined;
        const apiKey = pluginConfig?.apiKey || process.env.KAGI_API_KEY;

        if (!apiKey) {
          throw new Error(
            "Kagi API key required. Set KAGI_API_KEY env var or configure plugins.entries.kagi-search.config.apiKey",
          );
        }

        // Build Kagi Search API request
        const url = "https://kagi.com/api/v0/search";
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bot ${apiKey}`,
          },
          body: JSON.stringify({
            q: params.query,
            limit: Math.min(params.count, 10),
          }),
          signal: AbortSignal.timeout(ctx.timeoutSeconds * 1000),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Kagi API error (${response.status}): ${text || response.statusText}`);
        }

        const data = (await response.json()) as {
          meta?: { id?: string; node?: string; ms?: number };
          data?: Array<{
            t?: number;
            title?: string;
            snippet?: string;
            url?: string;
            published?: string;
          }>;
        };

        const results =
          data.data
            ?.filter((item) => item.t === 0) // Type 0 = search result
            .map((item) => ({
              title: item.title || "",
              url: item.url || "",
              description: item.snippet || "",
              published: item.published,
            })) || [];

        return {
          query: params.query,
          provider: "kagi",
          results,
          tookMs: data.meta?.ms,
        };
      },
    });
  },

  configSchema: {
    jsonSchema: {
      type: "object",
      properties: {
        apiKey: {
          type: "string",
          description: "Kagi API token",
        },
      },
    },
    uiHints: {
      apiKey: {
        label: "Kagi API Key",
        help: "Get your API key from https://kagi.com/settings?p=api",
        sensitive: true,
      },
    },
  },
};

export default plugin;
