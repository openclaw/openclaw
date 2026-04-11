import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { WebFetchProviderPlugin } from "openclaw/plugin-sdk/provider-web-fetch";
import { enablePluginInConfig } from "openclaw/plugin-sdk/provider-web-fetch";
import { runMrScraperFetchHtml } from "./mrscraper-client.js";

const MrScraperWebFetchSchema = Type.Object(
  {
    url: Type.String({ description: "HTTP or HTTPS URL to fetch through MrScraper." }),
    maxChars: Type.Optional(
      Type.Number({
        description: "Maximum characters to return.",
        minimum: 100,
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        description: "Timeout in seconds for the unblocker request.",
        minimum: 1,
      }),
    ),
    geoCode: Type.Optional(
      Type.String({
        description: "Optional country code for routed unblocker traffic, for example SG or US.",
      }),
    ),
    blockResources: Type.Optional(
      Type.Boolean({
        description: "Block images, fonts, and similar resources to speed up fetches.",
      }),
    ),
  },
  { additionalProperties: false },
);

function readConfiguredCredential(config?: OpenClawConfig): unknown {
  return (config?.plugins?.entries?.mrscraper?.config as { apiToken?: unknown } | undefined)
    ?.apiToken;
}

export function createMrScraperWebFetchProvider(): WebFetchProviderPlugin {
  return {
    id: "mrscraper",
    label: "MrScraper",
    hint: "Fetch blocked pages with a stealth browser and IP rotation.",
    envVars: ["MRSCRAPER_API_TOKEN"],
    placeholder: "atk_...",
    signupUrl: "https://mrscraper.com/",
    docsUrl: "https://mrscraper.com/",
    autoDetectOrder: 60,
    credentialPath: "plugins.entries.mrscraper.config.apiToken",
    inactiveSecretPaths: ["plugins.entries.mrscraper.config.apiToken"],
    getCredentialValue: (fetchConfig) => {
      if (!fetchConfig || typeof fetchConfig !== "object") {
        return undefined;
      }
      const scoped = (fetchConfig as { mrscraper?: { apiToken?: unknown } }).mrscraper;
      return scoped?.apiToken;
    },
    setCredentialValue: (fetchConfigTarget, value) => {
      const current =
        fetchConfigTarget.mrscraper &&
        typeof fetchConfigTarget.mrscraper === "object" &&
        !Array.isArray(fetchConfigTarget.mrscraper)
          ? (fetchConfigTarget.mrscraper as Record<string, unknown>)
          : {};
      current.apiToken = value;
      fetchConfigTarget.mrscraper = current;
    },
    getConfiguredCredentialValue: (config) => readConfiguredCredential(config),
    setConfiguredCredentialValue: (configTarget, value) => {
      const plugins = (configTarget.plugins ??= {});
      const entries = (plugins.entries ??= {});
      const entry = (entries.mrscraper ??= {});
      const pluginConfig =
        entry.config && typeof entry.config === "object" && !Array.isArray(entry.config)
          ? entry.config
          : ((entry.config = {}), entry.config);
      pluginConfig.apiToken = value;
    },
    applySelectionConfig: (config) => enablePluginInConfig(config, "mrscraper").config,
    createTool: ({ config }) => ({
      description:
        "Fetch a page through MrScraper's unblocker. Helpful for JS-heavy or bot-protected pages.",
      parameters: MrScraperWebFetchSchema,
      execute: async (args) =>
        await runMrScraperFetchHtml({
          cfg: config,
          url: typeof args.url === "string" ? args.url : "",
          maxChars:
            typeof args.maxChars === "number" && Number.isFinite(args.maxChars)
              ? Math.floor(args.maxChars)
              : undefined,
          timeoutSeconds:
            typeof args.timeoutSeconds === "number" && Number.isFinite(args.timeoutSeconds)
              ? Math.floor(args.timeoutSeconds)
              : undefined,
          geoCode: typeof args.geoCode === "string" ? args.geoCode : undefined,
          blockResources:
            typeof args.blockResources === "boolean" ? args.blockResources : undefined,
        }),
    }),
  };
}
