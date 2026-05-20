export const APIFY_PLUGIN_ID = "apify";
export const APIFY_ENV_VARS: string[] = ["APIFY_API_KEY"];
export const APIFY_CREDENTIAL_PATH = "plugins.entries.apify.config.apiKey";
export const APIFY_CREDENTIAL_LABEL = "Apify API token";
export const APIFY_PLACEHOLDER = "apify_...";
export const APIFY_SIGNUP_URL = "https://apify.com/";

export const APIFY_INTEGRATION_HEADERS = {
  "x-apify-integration-platform": "openclaw",
  "x-apify-integration-ai-tool": "true",
} as const;

export const APIFY_SEARCH_LABEL = "Apify RAG Web Browser";
export const APIFY_SEARCH_HINT =
  "Headless-rendered search results with full page content extraction.";
export const APIFY_SEARCH_DOCS_URL = "https://apify.com/apify/rag-web-browser";
export const APIFY_SEARCH_AUTO_DETECT_ORDER = 60;

export function resolveApifyPluginApiKey(config: unknown): unknown {
  return (
    config as {
      plugins?: { entries?: { apify?: { config?: { apiKey?: unknown } } } };
    }
  )?.plugins?.entries?.apify?.config?.apiKey;
}

export function ensureRecord(
  target: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const current = target[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

export function setApifyPluginApiKey(configTarget: unknown, value: unknown): void {
  const plugins = ensureRecord(configTarget as Record<string, unknown>, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const apifyEntry = ensureRecord(entries, "apify");
  const pluginConfig = ensureRecord(apifyEntry, "config");
  pluginConfig.apiKey = value;
}
