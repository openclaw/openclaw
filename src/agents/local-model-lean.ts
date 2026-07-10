/**
 * Local-model lean tool filtering.
 * Removes high-latency or channel-dependent tools for local models while
 * preserving explicitly required delivery tools.
 */
import { isPrivateOrLoopbackIpAddress } from "@openclaw/net-policy/ip";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope-config.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import { expandToolGroups, normalizeToolName } from "./tool-policy.js";

const LOCAL_MODEL_LEAN_DENY_TOOL_NAMES = new Set([
  "browser",
  "cron",
  "image_generate",
  "message",
  "music_generate",
  "pdf",
  "tts",
  "video_generate",
]);
const LOCAL_MODEL_LEAN_DIRECT_TOOL_NAMES = new Set(["exec"]);
const LOCAL_MODEL_LEAN_TOOL_SEARCH_DEFAULTS = {
  enabled: true,
  mode: "tools",
  searchDefaultLimit: 5,
  maxSearchLimit: 10,
} as const;

const KNOWN_LOCAL_MODEL_PROVIDERS = new Set([
  "llama-cpp",
  "lm-studio",
  "lmstudio",
  "ollama",
  "ollama-local",
]);
const KNOWN_LOCAL_MODEL_APIS = new Set(["llama-cpp", "lm-studio", "lmstudio", "ollama"]);

// These provider ids have hosted default transports. A configured local endpoint
// or local service always takes precedence, so custom local overrides remain lean.
const KNOWN_HOSTED_MODEL_PROVIDERS = new Set([
  "anthropic",
  "bedrock",
  "cerebras",
  "chutes",
  "cohere",
  "deepinfra",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-gemini-cli",
  "google-vertex",
  "groq",
  "meta",
  "minimax",
  "mistral",
  "moonshot",
  "opencode",
  "opencode-go",
  "openai",
  "openrouter",
  "perplexity",
  "together",
  "vercel-ai-gateway",
  "xai",
  "zai",
]);

type LocalModelLeanModelScope = {
  modelProvider?: string;
  modelApi?: string;
  modelBaseUrl?: string;
  modelId?: string;
};

type ConfiguredModelProvider = NonNullable<
  NonNullable<OpenClawConfig["models"]>["providers"]
>[string];

function normalizeModelScopeValue(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function resolveConfiguredModelProvider(params: {
  config?: OpenClawConfig;
  modelProvider?: string;
}): ConfiguredModelProvider | undefined {
  const provider = normalizeModelScopeValue(params.modelProvider);
  if (!provider) {
    return undefined;
  }
  const providers = params.config?.models?.providers;
  if (!providers) {
    return undefined;
  }
  for (const [candidate, providerConfig] of Object.entries(providers)) {
    if (normalizeModelScopeValue(candidate) === provider) {
      return providerConfig;
    }
  }
  return undefined;
}

function resolveConfiguredModelBaseUrl(params: {
  providerConfig: ConfiguredModelProvider;
  modelId?: string;
}): string | undefined {
  const modelId = normalizeModelScopeValue(params.modelId);
  if (modelId) {
    const unqualifiedModelId = modelId.includes("/")
      ? modelId.slice(modelId.indexOf("/") + 1)
      : modelId;
    const configuredModel = params.providerConfig.models?.find((candidate) => {
      const candidateId = normalizeModelScopeValue(candidate.id);
      return candidateId === modelId || candidateId === unqualifiedModelId;
    });
    const modelBaseUrl = configuredModel?.baseUrl?.trim();
    if (modelBaseUrl) {
      return modelBaseUrl;
    }
  }
  const providerBaseUrl = params.providerConfig.baseUrl?.trim();
  return providerBaseUrl || undefined;
}

function resolveConfiguredEndpointLocality(baseUrl: string | undefined): boolean | undefined {
  if (!baseUrl) {
    return undefined;
  }
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    const hostname = parsed.hostname
      .trim()
      .toLowerCase()
      .replace(/^\[(.*)\]$/, "$1")
      .replace(/\.+$/, "");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "host.docker.internal" ||
      hostname === "gateway.docker.internal" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".lan") ||
      hostname.endsWith(".home.arpa") ||
      (!hostname.includes(".") && !hostname.includes(":"))
    ) {
      return true;
    }
    if (isPrivateOrLoopbackIpAddress(hostname)) {
      return true;
    }
    return false;
  } catch {
    return undefined;
  }
}

function resolveConfiguredPrimaryModelProvider(params: {
  config?: OpenClawConfig;
  agentId?: string;
}): string | undefined {
  if (!params.config) {
    return undefined;
  }
  const agentModel = params.agentId
    ? resolveAgentConfig(params.config, params.agentId)?.model
    : undefined;
  const primaryModel =
    resolveAgentModelPrimaryValue(agentModel) ??
    resolveAgentModelPrimaryValue(params.config.agents?.defaults?.model);
  if (!primaryModel) {
    return undefined;
  }
  const slashIndex = primaryModel.indexOf("/");
  if (slashIndex <= 0) {
    return undefined;
  }
  return normalizeModelScopeValue(primaryModel.slice(0, slashIndex));
}

function resolveLocalModelLeanModelLocality(
  params: {
    config?: OpenClawConfig;
    configuredPrimaryProvider?: string;
  } & LocalModelLeanModelScope,
): boolean | undefined {
  const provider = normalizeModelScopeValue(params.modelProvider);
  const api = normalizeModelScopeValue(params.modelApi);
  const modelId = normalizeModelScopeValue(params.modelId);

  const resolvedEndpointLocality = resolveConfiguredEndpointLocality(params.modelBaseUrl);
  if (resolvedEndpointLocality !== undefined) {
    return resolvedEndpointLocality;
  }

  const providerConfig = resolveConfiguredModelProvider(params);
  if (providerConfig?.localService) {
    return true;
  }
  const configuredEndpointLocality = providerConfig
    ? resolveConfiguredEndpointLocality(
        resolveConfiguredModelBaseUrl({
          providerConfig,
          modelId: params.modelId,
        }),
      )
    : undefined;
  if (configuredEndpointLocality !== undefined) {
    return configuredEndpointLocality;
  }

  if (
    KNOWN_LOCAL_MODEL_PROVIDERS.has(provider) ||
    KNOWN_LOCAL_MODEL_APIS.has(api) ||
    modelId.startsWith("ollama/") ||
    modelId.startsWith("ollama-local/") ||
    modelId.startsWith("lmstudio/") ||
    modelId.startsWith("lm-studio/")
  ) {
    return true;
  }
  if (KNOWN_HOSTED_MODEL_PROVIDERS.has(provider)) {
    const configuredPrimaryProvider = normalizeModelScopeValue(params.configuredPrimaryProvider);
    if (configuredPrimaryProvider && configuredPrimaryProvider !== provider) {
      return false;
    }
  }

  // When endpoint or configured-provider facts do not establish locality,
  // preserve the existing explicit opt-in behavior.
  return undefined;
}

function resolvePreservedLocalModelLeanToolNames(names?: Iterable<string>) {
  if (!names) {
    return [];
  }
  return compileGlobPatterns({
    raw: expandToolGroups([...names]).filter((name) => normalizeToolName(name) !== "*"),
    normalize: normalizeToolName,
  });
}

/** Resolves tool names that must survive local-model lean filtering. */
export function resolveLocalModelLeanPreserveToolNames(params?: {
  toolNames?: Iterable<string>;
  forceMessageTool?: boolean;
  sourceReplyDeliveryMode?: string;
}): string[] {
  const names = [...(params?.toolNames ?? [])];
  if (params?.forceMessageTool || params?.sourceReplyDeliveryMode === "message_tool_only") {
    names.push("message");
  }
  return [...new Set(names)];
}

// Agent id may arrive explicitly, through the session key, or via config default.
// Resolve once so default/agent experimental flags use the same scope.
function resolveLocalModelLeanAgentId(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): string | undefined {
  const explicitAgentId =
    typeof params.agentId === "string" && params.agentId.trim()
      ? normalizeAgentId(params.agentId)
      : undefined;
  if (explicitAgentId) {
    return explicitAgentId;
  }
  const parsedSessionAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  if (parsedSessionAgentId) {
    return normalizeAgentId(parsedSessionAgentId);
  }
  return params.config ? resolveDefaultAgentId(params.config) : undefined;
}

/** Returns true when local-model lean mode is enabled for the selected agent. */
export function isLocalModelLeanEnabled(
  params: {
    config?: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
  } & LocalModelLeanModelScope,
): boolean {
  const normalizedAgentId = resolveLocalModelLeanAgentId(params);
  const resolvedExperimental =
    params.config && normalizedAgentId
      ? (resolveAgentConfig(params.config, normalizedAgentId)?.experimental ??
        params.config.agents?.defaults?.experimental)
      : params.config?.agents?.defaults?.experimental;
  if (resolvedExperimental?.localModelLean !== true) {
    return false;
  }
  return (
    resolveLocalModelLeanModelLocality({
      ...params,
      configuredPrimaryProvider: resolveConfiguredPrimaryModelProvider({
        config: params.config,
        agentId: normalizedAgentId,
      }),
    }) !== false
  );
}

/** Filters tools for local-model lean mode while preserving required delivery tools. */
export function filterLocalModelLeanTools(
  params: {
    tools: AnyAgentTool[];
    config?: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
    preserveToolNames?: Iterable<string>;
  } & LocalModelLeanModelScope,
): AnyAgentTool[] {
  if (!isLocalModelLeanEnabled(params)) {
    return params.tools;
  }
  const preservedToolNames = resolvePreservedLocalModelLeanToolNames(params.preserveToolNames);
  return params.tools.filter((tool) => {
    const normalizedName = normalizeToolName(tool.name);
    return (
      matchesAnyGlobPattern(normalizedName, preservedToolNames) ||
      !LOCAL_MODEL_LEAN_DENY_TOOL_NAMES.has(normalizedName)
    );
  });
}

// Lean mode targets coding-tuned local models; keep their familiar shell
// primitive visible instead of requiring a catalog search to rediscover it.
export function shouldCatalogToolForLocalModelLean(tool: AnyAgentTool): boolean {
  return !LOCAL_MODEL_LEAN_DIRECT_TOOL_NAMES.has(normalizeToolName(tool.name));
}

export function applyLocalModelLeanToolSearchDefaults(
  params: {
    config?: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
  } & LocalModelLeanModelScope,
): OpenClawConfig | undefined {
  if (!params.config || !isLocalModelLeanEnabled(params)) {
    return params.config;
  }
  if (params.config.tools?.toolSearch !== undefined) {
    return params.config;
  }
  return {
    ...params.config,
    tools: {
      ...params.config.tools,
      toolSearch: LOCAL_MODEL_LEAN_TOOL_SEARCH_DEFAULTS,
    },
  };
}
