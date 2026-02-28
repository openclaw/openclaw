/**
 * Local model provider resolver for corporate LAN deployments.
 *
 * Reads `localModelSecurity.localProviders` from the OpenClaw config and
 * produces model provider entries that integrate with the existing
 * models-config provider system. Supports Ollama, vLLM, and generic
 * OpenAI-compatible servers.
 *
 * Security features:
 * - Validates that provider baseUrls point to local/private network addresses.
 * - Optionally enforces TLS even for LAN connections.
 * - Filters out cloud providers when `blockCloudProviders` is enabled.
 */

import type { OpenClawConfig } from "../config/config.js";
import type {
  LocalModelSecurityConfig,
  LocalProviderConfig,
} from "../config/types.local-model-security.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isLocalNetworkAddress, resolveSecurityMode } from "../security/network-egress-guard.js";

const log = createSubsystemLogger("agents/local-model-provider");

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_VLLM_BASE_URL = "http://127.0.0.1:8000/v1";

const DEFAULT_LOCAL_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const DEFAULT_LOCAL_CONTEXT_WINDOW = 128000;
const DEFAULT_LOCAL_MAX_TOKENS = 8192;

interface DiscoveredModel {
  id: string;
  name: string;
  reasoning: boolean;
}

/**
 * Validate that a base URL points to a local/private network address.
 * Returns true if the URL is safe for local-only mode.
 */
export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    // Strip IPv6 brackets: new URL("http://[::1]:11434").hostname === "[::1]"
    let hostname = parsed.hostname.toLowerCase();
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      hostname = hostname.slice(1, -1);
    }

    // Always allow loopback.
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      return true;
    }

    // Allow .local and .lan domains (mDNS / corporate DNS).
    if (
      hostname.endsWith(".local") ||
      hostname.endsWith(".lan") ||
      hostname.endsWith(".internal")
    ) {
      return true;
    }

    // Check private IP ranges.
    if (isLocalNetworkAddress(hostname)) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Validate TLS requirements for a local provider.
 */
function validateTlsRequirement(
  provider: LocalProviderConfig,
  globalRequireTls: boolean,
): string | null {
  const requireTls = provider.requireTls ?? globalRequireTls;
  if (!requireTls) {
    return null;
  }

  try {
    const parsed = new URL(provider.baseUrl);
    if (parsed.protocol === "https:") {
      return null;
    }
    // Allow plain HTTP for loopback even when TLS is required.
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      return null;
    }
    return `Provider "${provider.name ?? provider.baseUrl}" requires TLS but uses ${parsed.protocol}`;
  } catch {
    return `Provider "${provider.name ?? provider.baseUrl}" has an invalid baseUrl`;
  }
}

/**
 * Discover models from an Ollama instance via its /api/tags endpoint.
 */
async function discoverOllamaModelsLocal(baseUrl: string): Promise<DiscoveredModel[]> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return [];
  }
  try {
    const trimmed = baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
    const response = await fetch(`${trimmed}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      log.warn(`Ollama model discovery failed (${response.status}) at ${trimmed}`);
      return [];
    }
    const data = (await response.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => ({
      id: m.name,
      name: m.name,
      reasoning: m.name.toLowerCase().includes("r1") || m.name.toLowerCase().includes("reasoning"),
    }));
  } catch (error) {
    log.warn(`Ollama model discovery error: ${String(error)}`);
    return [];
  }
}

/**
 * Discover models from a vLLM instance via its /models endpoint.
 */
async function discoverVllmModelsLocal(
  baseUrl: string,
  apiKey?: string,
): Promise<DiscoveredModel[]> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return [];
  }
  try {
    const trimmed = baseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = {};
    if (apiKey?.trim()) {
      headers.Authorization = `Bearer ${apiKey.trim()}`;
    }
    const response = await fetch(`${trimmed}/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      log.warn(`vLLM model discovery failed (${response.status}) at ${trimmed}`);
      return [];
    }
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? [])
      .filter((m) => typeof m.id === "string" && m.id.trim())
      .map((m) => {
        const id = m.id!.trim();
        const lower = id.toLowerCase();
        return {
          id,
          name: id,
          reasoning: lower.includes("r1") || lower.includes("reasoning") || lower.includes("think"),
        };
      });
  } catch (error) {
    log.warn(`vLLM model discovery error: ${String(error)}`);
    return [];
  }
}

function buildModelDefinition(model: DiscoveredModel): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: ["text"],
    cost: DEFAULT_LOCAL_COST,
    contextWindow: DEFAULT_LOCAL_CONTEXT_WINDOW,
    maxTokens: DEFAULT_LOCAL_MAX_TOKENS,
  };
}

/**
 * Resolve a single local provider config into a ModelProviderConfig.
 */
async function resolveLocalProvider(
  provider: LocalProviderConfig,
  securityConfig: LocalModelSecurityConfig,
): Promise<{ key: string; config: ModelProviderConfig } | null> {
  // Validate that the base URL is on the local network.
  const mode = resolveSecurityMode(securityConfig);
  if (mode === "enforced" && !isLocalBaseUrl(provider.baseUrl)) {
    log.error(
      `Blocked non-local provider "${provider.name ?? provider.type}": ${provider.baseUrl} is not a local address`,
    );
    return null;
  }
  if (mode === "audit" && !isLocalBaseUrl(provider.baseUrl)) {
    log.warn(
      `[AUDIT] Non-local provider "${provider.name ?? provider.type}": ${provider.baseUrl} is not a local address`,
    );
  }

  // Validate TLS requirement.
  const tlsError = validateTlsRequirement(provider, securityConfig.requireTls ?? false);
  if (tlsError) {
    if (mode === "enforced") {
      log.error(tlsError);
      return null;
    }
    if (mode === "audit") {
      log.warn(`[AUDIT] ${tlsError}`);
    }
  }

  let models: ModelDefinitionConfig[];
  let api: string;
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");

  switch (provider.type) {
    case "ollama": {
      const discovered = await discoverOllamaModelsLocal(baseUrl);
      models = discovered.map(buildModelDefinition);
      api = "ollama";
      break;
    }
    case "vllm": {
      const discovered = await discoverVllmModelsLocal(baseUrl, provider.apiKey);
      models = discovered.map(buildModelDefinition);
      api = "openai-completions";
      break;
    }
    case "custom-openai": {
      // For custom servers, we don't auto-discover. The user configures models
      // via the standard models.providers config; here we just validate the URL.
      models = [];
      api = "openai-completions";
      break;
    }
    default:
      log.warn(`Unknown local provider type: ${String((provider as { type: string }).type)}`);
      return null;
  }

  const key = `local-${provider.type}-${provider.name ?? "default"}`
    .toLowerCase()
    .replace(/\s+/g, "-");
  return {
    key,
    config: {
      baseUrl,
      api: api as ModelDefinitionConfig["api"],
      apiKey: provider.apiKey,
      models,
    },
  };
}

/**
 * Resolve all local providers from the localModelSecurity config.
 * Returns a map of provider key -> ModelProviderConfig.
 */
export async function resolveLocalProviders(
  config?: OpenClawConfig,
): Promise<Record<string, ModelProviderConfig>> {
  const securityConfig = config?.localModelSecurity;
  const mode = resolveSecurityMode(securityConfig);
  if (mode === "off") {
    return {};
  }

  const localProviders = securityConfig?.localProviders;
  if (!localProviders || localProviders.length === 0) {
    return {};
  }

  const result: Record<string, ModelProviderConfig> = {};
  for (const provider of localProviders) {
    const resolved = await resolveLocalProvider(provider, securityConfig);
    if (resolved) {
      result[resolved.key] = resolved.config;
    }
  }

  return result;
}

/**
 * Filter out cloud providers from a providers map when local-only mode is active.
 * Returns a new map with cloud providers removed.
 */
export function filterCloudProviders(
  providers: Record<string, ModelProviderConfig>,
  securityConfig?: LocalModelSecurityConfig,
): Record<string, ModelProviderConfig> {
  const mode = resolveSecurityMode(securityConfig);
  if (mode === "off") {
    return providers;
  }

  const blockCloud = securityConfig?.blockCloudProviders ?? mode === "enforced";
  if (!blockCloud) {
    return providers;
  }

  const filtered: Record<string, ModelProviderConfig> = {};
  for (const [key, provider] of Object.entries(providers)) {
    try {
      const parsed = new URL(provider.baseUrl);
      const hostname = parsed.hostname.toLowerCase();

      // Allow providers that point to local addresses.
      if (isLocalBaseUrl(provider.baseUrl)) {
        filtered[key] = provider;
        continue;
      }

      if (mode === "enforced") {
        log.info(`Filtered out cloud provider "${key}" (${hostname}) in local-only mode`);
        continue;
      }

      // audit mode: keep but log.
      log.warn(`[AUDIT] Cloud provider "${key}" (${hostname}) would be blocked in enforced mode`);
      filtered[key] = provider;
    } catch {
      // Invalid URL, keep as-is (schema validation will catch this elsewhere).
      filtered[key] = provider;
    }
  }

  return filtered;
}

/**
 * Get default base URL for a local provider type.
 */
export function getDefaultLocalBaseUrl(type: LocalProviderConfig["type"]): string {
  switch (type) {
    case "ollama":
      return DEFAULT_OLLAMA_BASE_URL;
    case "vllm":
      return DEFAULT_VLLM_BASE_URL;
    case "custom-openai":
      return "http://127.0.0.1:8080/v1";
  }
}
