import type {
  SearchConfigRecord,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
} from "openclaw/plugin-sdk/provider-web-search";
import { isRecord } from "openclaw/plugin-sdk/text-runtime";

const SERPER_API_URL = "https://google.serper.dev/search";
const PLUGIN_ID = "serper";

interface SerperConfig {
  apiKey?: string;
  gl?: string;
  hl?: string;
  num?: number;
}

interface SerperResult {
  title?: string;
  link?: string;
  snippet?: string;
}

interface SerperResponse {
  organic?: SerperResult[];
}

type ConfigInput = Parameters<
  NonNullable<WebSearchProviderPlugin["getConfiguredCredentialValue"]>
>[0];
type ConfigTarget = Parameters<
  NonNullable<WebSearchProviderPlugin["setConfiguredCredentialValue"]>
>[0];

function resolvePluginConfig(
  config: ConfigInput,
  pluginId: string,
): Record<string, unknown> | undefined {
  if (!isRecord(config)) return undefined;
  const plugins = isRecord(config.plugins) ? config.plugins : undefined;
  const entries = isRecord(plugins?.entries) ? plugins.entries : undefined;
  const entry = isRecord(entries?.[pluginId]) ? entries[pluginId] : undefined;
  const pluginConfig = isRecord(entry?.config) ? entry.config : undefined;
  return isRecord(pluginConfig?.webSearch) ? pluginConfig.webSearch : undefined;
}

function ensureObject(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = target[key];
  if (isRecord(current)) return current;
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

function resolveSerperConfig(searchConfig?: SearchConfigRecord): SerperConfig {
  const serper = searchConfig?.serper;
  return serper && typeof serper === "object" && !Array.isArray(serper)
    ? (serper as SerperConfig)
    : {};
}

function mergeScopedSearchConfig(
  searchConfig: SearchConfigRecord | undefined,
  key: string,
  pluginConfig: Record<string, unknown> | undefined,
  options?: { mirrorApiKeyToTopLevel?: boolean },
): SearchConfigRecord | undefined {
  if (!pluginConfig) return searchConfig;
  const currentScoped = isRecord(searchConfig?.[key]) ? searchConfig?.[key] : {};
  const next: SearchConfigRecord = {
    ...searchConfig,
    [key]: { ...currentScoped, ...pluginConfig },
  };
  if (options?.mirrorApiKeyToTopLevel && pluginConfig.apiKey !== undefined) {
    next.apiKey = pluginConfig.apiKey;
  }
  return next;
}

function resolveApiKey(searchConfig?: SearchConfigRecord): string | undefined {
  const fromSearch = searchConfig?.apiKey;
  if (typeof fromSearch === "string" && fromSearch.trim()) return fromSearch.trim();
  const fromSerper = resolveSerperConfig(searchConfig).apiKey;
  if (typeof fromSerper === "string" && fromSerper.trim()) return fromSerper.trim();
  return process.env.SERPER_API_KEY?.trim() || undefined;
}

function createSerperToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  const serperConfig = resolveSerperConfig(searchConfig);
  const apiKey = resolveApiKey(searchConfig);

  return {
    id: PLUGIN_ID,
    label: "Serper (Google Search)",
    description: "Search the web using Google via Serper.dev",
    isConfigured: Boolean(apiKey),
    execute: async (query: string, options?: { numResults?: number }) => {
      if (!apiKey) {
        throw new Error(
          "Serper API key not configured. Set SERPER_API_KEY or configure via plugin settings.",
        );
      }

      const num = options?.numResults ?? serperConfig.num ?? 10;
      const body: Record<string, unknown> = { q: query, num };
      if (serperConfig.gl) body.gl = serperConfig.gl;
      if (serperConfig.hl) body.hl = serperConfig.hl;

      const response = await fetch(SERPER_API_URL, {
        method: "POST",
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Serper API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as SerperResponse;
      return (data.organic ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.link ?? "",
        snippet: r.snippet ?? "",
      }));
    },
  };
}

export function createSerperWebSearchProviderPlugin(): WebSearchProviderPlugin {
  const credentialPath = `plugins.entries.${PLUGIN_ID}.config.webSearch.apiKey`;

  return {
    id: PLUGIN_ID,
    label: "Serper (Google Search)",
    hint: "Real Google results · country/language filters",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Serper API key",
    envVars: ["SERPER_API_KEY"],
    placeholder: "your-serper-api-key",
    signupUrl: "https://serper.dev",
    autoDetectOrder: 15,
    credentialPath,

    getConfiguredCredentialValue(config: ConfigInput): unknown {
      return resolvePluginConfig(config, PLUGIN_ID)?.apiKey;
    },

    setConfiguredCredentialValue(configTarget: ConfigTarget, value: unknown): void {
      const plugins = ensureObject(configTarget as Record<string, unknown>, "plugins");
      const entries = ensureObject(plugins, "entries");
      const entry = ensureObject(entries, PLUGIN_ID);
      if (entry.enabled === undefined) entry.enabled = true;
      const config = ensureObject(entry, "config");
      const webSearch = ensureObject(config, "webSearch");
      webSearch.apiKey = value;
    },

    createTool: (ctx) =>
      createSerperToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig,
          PLUGIN_ID,
          resolvePluginConfig(ctx.config, PLUGIN_ID),
          { mirrorApiKeyToTopLevel: true },
        ),
      ),
  };
}
