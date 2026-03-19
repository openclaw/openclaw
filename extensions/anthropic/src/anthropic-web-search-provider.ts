import { Type } from "@sinclair/typebox";
import {
  formatCliCommand,
  resolveProviderWebSearchPluginConfig,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
} from "openclaw/plugin-sdk/provider-web-search";

/**
 * Anthropic native web search provider.
 *
 * Unlike other providers that intercept the `web_search` tool call and route
 * to external APIs, this provider signals that Anthropic's server-side
 * `web_search_20260209` tool should be injected directly into the Messages API
 * request. Claude handles search execution server-side.
 *
 * The actual server tool injection happens via a stream wrapper that patches
 * the Anthropic API payload (see `createAnthropicNativeSearchStreamWrapper`).
 */

const ANTHROPIC_WEB_SEARCH_TOOL_VERSIONS = [
  "web_search_20250305",
  "web_search_20260209",
] as const;

type AnthropicWebSearchToolVersion = (typeof ANTHROPIC_WEB_SEARCH_TOOL_VERSIONS)[number];

const DEFAULT_TOOL_VERSION: AnthropicWebSearchToolVersion = "web_search_20260209";

type AnthropicWebSearchConfig = {
  toolVersion?: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxUses?: number;
  userLocation?: {
    type?: string;
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
  };
};

function resolveAnthropicWebSearchConfig(
  searchConfig?: SearchConfigRecord,
): AnthropicWebSearchConfig {
  const anthropic = searchConfig?.anthropic;
  return anthropic && typeof anthropic === "object" && !Array.isArray(anthropic)
    ? (anthropic as AnthropicWebSearchConfig)
    : {};
}

function resolveToolVersion(config: AnthropicWebSearchConfig): AnthropicWebSearchToolVersion {
  const version = config.toolVersion?.trim();
  if (
    version &&
    ANTHROPIC_WEB_SEARCH_TOOL_VERSIONS.includes(version as AnthropicWebSearchToolVersion)
  ) {
    return version as AnthropicWebSearchToolVersion;
  }
  return DEFAULT_TOOL_VERSION;
}

/**
 * Build the Anthropic server tool definition to inject into the API payload.
 * This is NOT a regular OpenClaw tool — it's the raw Anthropic server tool spec
 * that gets added to the `tools` array in the Messages API request.
 */
export function buildAnthropicWebSearchServerTool(
  searchConfig?: SearchConfigRecord,
): Record<string, unknown> {
  const config = resolveAnthropicWebSearchConfig(searchConfig);
  const toolVersion = resolveToolVersion(config);

  const tool: Record<string, unknown> = {
    type: toolVersion,
    name: "web_search",
  };

  if (config.allowedDomains?.length) {
    tool.allowed_domains = config.allowedDomains;
  }
  if (config.blockedDomains?.length) {
    tool.blocked_domains = config.blockedDomains;
  }
  if (typeof config.maxUses === "number" && config.maxUses > 0) {
    tool.max_uses = config.maxUses;
  }
  if (config.userLocation) {
    const loc: Record<string, string> = {};
    if (config.userLocation.type) loc.type = config.userLocation.type;
    if (config.userLocation.city) loc.city = config.userLocation.city;
    if (config.userLocation.region) loc.region = config.userLocation.region;
    if (config.userLocation.country) loc.country = config.userLocation.country;
    if (config.userLocation.timezone) loc.timezone = config.userLocation.timezone;
    if (Object.keys(loc).length > 0) {
      tool.user_location = loc;
    }
  }

  return tool;
}

function createAnthropicWebSearchToolDefinition(
  _searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Anthropic's native server-side web search. " +
      "Claude executes searches directly via the Messages API with built-in citations. " +
      "This is a server tool — searches are handled automatically.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query string." }),
    }),
    execute: async (_args) => {
      // This tool should never actually be called — the server tool handles
      // execution. If we get here, the provider is misconfigured.
      return {
        error: "anthropic_native_search_misconfigured",
        message:
          "Anthropic native web search is configured but the server tool was not injected. " +
          "This provider requires direct Anthropic API access (not proxied). " +
          `Run \`${formatCliCommand("openclaw configure --section web")}\` to check configuration.`,
      };
    },
  };
}

export function createAnthropicWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "anthropic",
    label: "Anthropic Native Search",
    hint: "Server-side search · built-in citations · domain filtering · prompt caching",
    envVars: ["ANTHROPIC_API_KEY"],
    placeholder: "sk-ant-...",
    signupUrl: "https://console.anthropic.com/",
    docsUrl: "https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search",
    autoDetectOrder: 50, // Lower priority than dedicated search providers
    credentialPath: "plugins.entries.anthropic.config.webSearch.enabled",
    inactiveSecretPaths: [],
    getCredentialValue: (_searchConfig) => {
      // Uses the main Anthropic API key — no separate credential needed
      return process.env.ANTHROPIC_API_KEY;
    },
    setCredentialValue: () => {
      // No-op: uses the main Anthropic API key
    },
    createTool: (ctx) =>
      createAnthropicWebSearchToolDefinition(
        (() => {
          const searchConfig = ctx.searchConfig as SearchConfigRecord | undefined;
          const pluginConfig = resolveProviderWebSearchPluginConfig(ctx.config, "anthropic");
          if (!pluginConfig) {
            return searchConfig;
          }
          return {
            ...(searchConfig ?? {}),
            anthropic: {
              ...resolveAnthropicWebSearchConfig(searchConfig),
              ...pluginConfig,
            },
          } as SearchConfigRecord;
        })(),
      ),
  };
}

export const __testing = {
  resolveAnthropicWebSearchConfig,
  resolveToolVersion,
  buildAnthropicWebSearchServerTool,
  ANTHROPIC_WEB_SEARCH_TOOL_VERSIONS,
  DEFAULT_TOOL_VERSION,
} as const;
