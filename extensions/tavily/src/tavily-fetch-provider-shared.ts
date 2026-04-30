import type { WebFetchProviderPlugin } from "openclaw/plugin-sdk/provider-web-fetch-contract";

type TavilyWebFetchProviderSharedFields = Omit<
  WebFetchProviderPlugin,
  "applySelectionConfig" | "createTool"
>;

function ensureRecord(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = target[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

// Tavily uses a single account/API key for both /search and /extract
// The canonical credential lives at webSearch.apiKey.
// webFetch.apiKey is honored as an optional override for parity with firecrawl's two-key model.
export const TAVILY_WEB_FETCH_PROVIDER_SHARED = {
  id: "tavily",
  label: "Tavily",
  hint: "Fetch URL contents via Tavily Extract for clean readable text.",
  envVars: ["TAVILY_API_KEY"],
  placeholder: "tvly-...",
  signupUrl: "https://tavily.com/",
  docsUrl: "https://docs.tavily.com",
  autoDetectOrder: 70,
  credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
  inactiveSecretPaths: [
    "plugins.entries.tavily.config.webSearch.apiKey",
    "plugins.entries.tavily.config.webFetch.apiKey",
    "tools.web.fetch.tavily.apiKey",
  ],
  getCredentialValue: (fetchConfig) => {
    if (!fetchConfig || typeof fetchConfig !== "object") {
      return undefined;
    }
    const legacy = (fetchConfig as { tavily?: unknown }).tavily;
    if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
      return undefined;
    }
    if ((legacy as { enabled?: boolean }).enabled === false) {
      return undefined;
    }
    return (legacy as { apiKey?: unknown }).apiKey;
  },
  setCredentialValue: (fetchConfigTarget, value) => {
    const tavily = ensureRecord(fetchConfigTarget, "tavily");
    tavily.apiKey = value;
  },
  getConfiguredCredentialValue: (config) => {
    const pluginConfig = config?.plugins?.entries?.tavily?.config as
      | { webSearch?: { apiKey?: unknown }; webFetch?: { apiKey?: unknown } }
      | undefined;
    return pluginConfig?.webFetch?.apiKey ?? pluginConfig?.webSearch?.apiKey;
  },
  setConfiguredCredentialValue: (configTarget, value) => {
    const plugins = ensureRecord(configTarget as unknown as Record<string, unknown>, "plugins");
    const entries = ensureRecord(plugins, "entries");
    const tavilyEntry = ensureRecord(entries, "tavily");
    const pluginConfig = ensureRecord(tavilyEntry, "config");
    const webSearch = ensureRecord(pluginConfig, "webSearch");
    webSearch.apiKey = value;
  },
} satisfies TavilyWebFetchProviderSharedFields;
