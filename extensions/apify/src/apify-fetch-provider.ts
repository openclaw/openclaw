import type { WebFetchProviderPlugin } from "openclaw/plugin-sdk/provider-web-fetch";
import {
  enablePluginInConfig,
  readNumberParam,
  readStringParam,
  resolveTimeoutSeconds,
} from "openclaw/plugin-sdk/provider-web-fetch";
import {
  readConfiguredSecretString,
  readProviderEnvValue,
} from "openclaw/plugin-sdk/provider-web-search";
import { APIFY_FETCH_PROVIDER_SHARED } from "./apify-fetch-provider-shared.js";
import type { CrawlerType } from "./apify-fetch-runtime.js";
import {
  APIFY_CREDENTIAL_PATH,
  APIFY_PLUGIN_ID,
  resolveApifyPluginApiKey,
} from "./apify-shared.js";

type ApifyFetchRuntime = typeof import("./apify-fetch-runtime.js");

let apifyFetchRuntimePromise: Promise<ApifyFetchRuntime> | undefined;

function loadApifyFetchRuntime(): Promise<ApifyFetchRuntime> {
  apifyFetchRuntimePromise ??= import("./apify-fetch-runtime.js");
  return apifyFetchRuntimePromise;
}

function resolveApifyFetchApiKey(config: unknown): string | undefined {
  return (
    readConfiguredSecretString(resolveApifyPluginApiKey(config), APIFY_CREDENTIAL_PATH) ??
    readProviderEnvValue(["APIFY_API_KEY"])
  );
}

function resolveCrawlerType(
  raw: unknown,
  fallback: CrawlerType = "playwright:adaptive",
): CrawlerType {
  if (raw === "cheerio" || raw === "playwright:firefox" || raw === "playwright:adaptive") {
    return raw;
  }
  return fallback;
}

const ApifyFetchSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "HTTP or HTTPS URL to fetch." },
    crawlerType: {
      type: "string",
      enum: ["cheerio", "playwright:firefox", "playwright:adaptive"],
      description:
        'Crawler type. "playwright:adaptive" (default) auto-selects between headless and full rendering. "playwright:firefox" forces full rendering for heavily bot-protected pages. "cheerio" is fastest for plain-HTML pages.',
    },
    maxChars: {
      type: "number",
      description: "Maximum characters to return.",
      minimum: 100,
    },
  },
  required: ["url"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createApifyWebFetchProvider(): WebFetchProviderPlugin {
  return {
    ...APIFY_FETCH_PROVIDER_SHARED,
    applySelectionConfig: (config) => enablePluginInConfig(config, APIFY_PLUGIN_ID).config,
    createTool: ({ config }) => {
      const apiKey = resolveApifyFetchApiKey(config);
      const webFetchConfig = (
        config as {
          plugins?: { entries?: { apify?: { config?: { webFetch?: Record<string, unknown> } } } };
        }
      )?.plugins?.entries?.apify?.config?.webFetch;
      const crawlerType = resolveCrawlerType(webFetchConfig?.crawlerType);
      const timeoutSeconds = resolveTimeoutSeconds(webFetchConfig?.timeoutSeconds, 60);
      return {
        description:
          "Fetch a web page using Apify Website Content Crawler. Returns full page content as markdown. " +
          'Default crawlerType "playwright:adaptive" auto-selects rendering. Use "playwright:firefox" for heavily bot-protected pages; "cheerio" for fast plain-HTML pages.',
        parameters: ApifyFetchSchema,
        execute: async (args: Record<string, unknown>) => {
          const url = readStringParam(args, "url", { required: true });
          const crawlerTypeArg = resolveCrawlerType(
            readStringParam(args, "crawlerType"),
            crawlerType,
          );
          const maxChars = readNumberParam(args, "maxChars", { integer: true });
          const { executeApifyFetch } = await loadApifyFetchRuntime();
          return executeApifyFetch(url, apiKey, crawlerTypeArg, timeoutSeconds, maxChars);
        },
      };
    },
  };
}
