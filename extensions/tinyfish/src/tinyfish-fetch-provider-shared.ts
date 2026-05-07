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

export const TINYFISH_WEB_FETCH_PROVIDER_SHARED = {
  id: "tinyfish",
  label: "TinyFish",
  hint: "Fetch pages using TinyFish for JS-heavy or bot-protected sites.",
  envVars: ["TINYFISH_API_KEY"],
  placeholder: "tf_live_...",
  signupUrl: "https://tinyfish.ai/",
  docsUrl: "https://docs.openclaw.ai/tools/tinyfish",
  autoDetectOrder: 55,
  credentialPath: "plugins.entries.tinyfish.config.webFetch.apiKey",
  inactiveSecretPaths: ["plugins.entries.tinyfish.config.webFetch.apiKey"],
  getCredentialValue: (fetchConfig: Record<string, unknown> | undefined) => {
    if (!fetchConfig || typeof fetchConfig !== "object") {
      return undefined;
    }
    const tinyfish = fetchConfig.tinyfish;
    if (!tinyfish || typeof tinyfish !== "object" || Array.isArray(tinyfish)) {
      return undefined;
    }
    if ((tinyfish as { enabled?: boolean }).enabled === false) {
      return undefined;
    }
    return (tinyfish as { apiKey?: unknown }).apiKey;
  },
  setCredentialValue: (fetchConfigTarget: Record<string, unknown>, value: unknown) => {
    const tinyfish = ensureRecord(fetchConfigTarget, "tinyfish");
    tinyfish.apiKey = value;
  },
  getConfiguredCredentialValue: (config?: { plugins?: { entries?: Record<string, unknown> } }) =>
    (
      config?.plugins?.entries?.tinyfish as
        | { config?: { webFetch?: { apiKey?: unknown } } }
        | undefined
    )?.config?.webFetch?.apiKey,
  setConfiguredCredentialValue: (configTarget: Record<string, unknown>, value: unknown) => {
    const plugins = ensureRecord(configTarget, "plugins");
    const entries = ensureRecord(plugins, "entries");
    const tinyfishEntry = ensureRecord(entries, "tinyfish");
    const pluginConfig = ensureRecord(tinyfishEntry, "config");
    const webFetch = ensureRecord(pluginConfig, "webFetch");
    webFetch.apiKey = value;
  },
} satisfies Omit<WebFetchProviderPlugin, "applySelectionConfig" | "createTool">;
