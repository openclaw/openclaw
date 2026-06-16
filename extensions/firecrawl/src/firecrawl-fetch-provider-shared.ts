// Firecrawl provider module implements model/runtime integration.
import type { WebFetchProviderPlugin } from "openclaw/plugin-sdk/provider-web-fetch-contract";

function ensureRecord(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = target[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

export const FIRECRAWL_WEB_FETCH_PROVIDER_SHARED = {
  id: "firecrawl",
  label: "Firecrawl",
  hint: "Fetch pages with Firecrawl for JS-heavy or bot-protected sites.",
  envVars: ["FIRECRAWL_API_KEY"],
  placeholder: "fc-...",
  signupUrl: "https://www.firecrawl.dev/",
  docsUrl: "https://docs.firecrawl.dev",
  autoDetectOrder: 50,
  credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
  inactiveSecretPaths: [
    "plugins.entries.firecrawl.config.webFetch.apiKey",
    "tools.web.fetch.firecrawl.apiKey",
  ],
  getCredentialValue: (fetchConfig) => {
    if (!fetchConfig || typeof fetchConfig !== "object") {
      return undefined;
    }
    const legacy = fetchConfig.firecrawl;
    if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
      return undefined;
    }
    if ((legacy as { enabled?: boolean }).enabled === false) {
      return undefined;
    }
    return (legacy as { apiKey?: unknown }).apiKey;
  },
  setCredentialValue: (fetchConfigTarget, value) => {
    const firecrawl = ensureRecord(fetchConfigTarget, "firecrawl");
    firecrawl.apiKey = value;
  },
  getConfiguredCredentialValue: (config) =>
    (config?.plugins?.entries?.firecrawl?.config as { webFetch?: { apiKey?: unknown } } | undefined)
      ?.webFetch?.apiKey,
  getConfiguredCredentialFallback: (config) => {
    const apiKey = (
      config?.plugins?.entries?.firecrawl?.config as
        | { webSearch?: { apiKey?: unknown } }
        | undefined
    )?.webSearch?.apiKey;
    return apiKey === undefined
      ? undefined
      : {
          path: "plugins.entries.firecrawl.config.webSearch.apiKey",
          value: apiKey,
        };
  },
  setConfiguredCredentialValue: (configTarget, value) => {
    const plugins = ensureRecord(configTarget as unknown as Record<string, unknown>, "plugins");
    const entries = ensureRecord(plugins, "entries");
    const firecrawlEntry = ensureRecord(entries, "firecrawl");
    const pluginConfig = ensureRecord(firecrawlEntry, "config");
    const webFetch = ensureRecord(pluginConfig, "webFetch");
    webFetch.apiKey = value;
  },
} satisfies Omit<WebFetchProviderPlugin, "applySelectionConfig" | "createTool">;

export const FIRECRAWL_FREE_WEB_FETCH_PROVIDER_SHARED = {
  id: "firecrawl-free",
  label: "Firecrawl (Free)",
  hint: "Fetch pages with Firecrawl — no API key required",
  requiresCredential: false,
  envVars: [],
  placeholder: "(no key needed)",
  signupUrl: "https://www.firecrawl.dev/",
  docsUrl: "https://docs.firecrawl.dev",
  autoDetectOrder: 76,
  credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
  getCredentialValue: (fetchConfig) => {
    if (!fetchConfig || typeof fetchConfig !== "object") {
      return undefined;
    }
    const entry = (fetchConfig as Record<string, unknown>)["firecrawl-free"];
    return entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as { apiKey?: unknown }).apiKey
      : undefined;
  },
  setCredentialValue: (fetchConfigTarget, value) => {
    const entry = ensureRecord(fetchConfigTarget, "firecrawl-free");
    entry.apiKey = value;
  },
} satisfies Omit<WebFetchProviderPlugin, "applySelectionConfig" | "createTool">;
