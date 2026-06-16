/**
 * Activates and injects OpenAI/Codex native web-search tools when config,
 * model API, and auth state allow it.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";
import { externalCliDiscoveryForProviderAuth } from "./auth-profiles/external-cli-discovery.js";
import { listProfilesForProvider } from "./auth-profiles/profile-list.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import {
  type CodexNativeSearchMode,
  resolveCodexNativeWebSearchConfig,
} from "./codex-native-web-search.shared.js";
import type { NativeWebSearchStreamParams } from "./command/shared-types.js";
import type { SandboxToolPolicy } from "./sandbox.js";
import {
  resolveWebSearchToolPolicy,
  type WebSearchToolPolicyParams,
} from "./web-search-tool-policy.js";

type CodexNativeSearchActivation = {
  globalWebSearchEnabled: boolean;
  codexNativeEnabled: boolean;
  codexMode: CodexNativeSearchMode;
  nativeEligible: boolean;
  hasRequiredAuth: boolean;
  state: "managed_only" | "native_active";
  inactiveReason?:
    | "globally_disabled"
    | "codex_not_enabled"
    | "model_not_eligible"
    | "codex_auth_missing"
    | "tool_policy_denied";
};

type CodexNativeSearchPayloadPatchResult = {
  status: "payload_not_object" | "native_tool_already_present" | "injected";
};

export type NativeWebSearchToolPolicyParams = WebSearchToolPolicyParams;

const OPENAI_AUTH_PROVIDER_IDS = ["openai"] as const;

export type NativeWebSearchToolOptions = NativeWebSearchStreamParams;

function isOpenAIAuthProviderId(provider: string | undefined): boolean {
  return OPENAI_AUTH_PROVIDER_IDS.some((candidate) => candidate === provider);
}

/** Returns whether a model API can accept the native Codex web_search tool. */
export function isCodexNativeSearchEligibleModel(params: {
  modelProvider?: string;
  modelApi?: string;
}): boolean {
  return params.modelApi === "openai-chatgpt-responses";
}

/** Checks whether OpenAI/Codex auth is available for native web search. */
export function hasAvailableCodexAuth(params: {
  config?: OpenClawConfig;
  agentDir?: string;
}): boolean {
  if (
    Object.values(params.config?.auth?.profiles ?? {}).some(
      (profile) =>
        isRecord(profile) &&
        isOpenAIAuthProviderId(profile.provider) &&
        (profile.mode === "oauth" || profile.mode === "token"),
    )
  ) {
    return true;
  }

  if (params.agentDir) {
    try {
      const store = ensureAuthProfileStore(params.agentDir, {
        externalCli: externalCliDiscoveryForProviderAuth({
          cfg: params.config,
          provider: "openai",
        }),
      });
      if (
        OPENAI_AUTH_PROVIDER_IDS.some(
          (provider) => listProfilesForProvider(store, provider).length > 0,
        )
      ) {
        return true;
      }
    } catch {
      // Fall back to config-based detection below.
    }
  }
  return false;
}

/** Resolves whether native search is active or why managed search should remain. */
export function resolveCodexNativeSearchActivation(params: {
  config?: OpenClawConfig;
  modelProvider?: string;
  modelApi?: string;
  modelId?: string;
  agentId?: string;
  sessionKey?: string;
  sandboxToolPolicy?: SandboxToolPolicy;
  messageProvider?: string;
  agentAccountId?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  agentDir?: string;
}): CodexNativeSearchActivation {
  const globalWebSearchEnabled = params.config?.tools?.web?.search?.enabled !== false;
  const codexConfig = resolveCodexNativeWebSearchConfig(params.config);
  const nativeEligible = isCodexNativeSearchEligibleModel(params);
  const hasRequiredAuth =
    params.modelApi !== "openai-chatgpt-responses" ||
    !isOpenAIAuthProviderId(params.modelProvider) ||
    hasAvailableCodexAuth(params);
  if (!globalWebSearchEnabled) {
    return {
      globalWebSearchEnabled,
      codexNativeEnabled: codexConfig.enabled,
      codexMode: codexConfig.mode,
      nativeEligible,
      hasRequiredAuth,
      state: "managed_only",
      inactiveReason: "globally_disabled",
    };
  }

  if (!codexConfig.enabled) {
    return {
      globalWebSearchEnabled,
      codexNativeEnabled: false,
      codexMode: codexConfig.mode,
      nativeEligible,
      hasRequiredAuth,
      state: "managed_only",
      inactiveReason: "codex_not_enabled",
    };
  }

  if (!nativeEligible) {
    return {
      globalWebSearchEnabled,
      codexNativeEnabled: true,
      codexMode: codexConfig.mode,
      nativeEligible: false,
      hasRequiredAuth,
      state: "managed_only",
      inactiveReason: "model_not_eligible",
    };
  }

  if (!hasRequiredAuth) {
    return {
      globalWebSearchEnabled,
      codexNativeEnabled: true,
      codexMode: codexConfig.mode,
      nativeEligible: true,
      hasRequiredAuth: false,
      state: "managed_only",
      inactiveReason: "codex_auth_missing",
    };
  }

  if (!isNativeWebSearchAllowedByToolPolicy(params)) {
    return {
      globalWebSearchEnabled,
      codexNativeEnabled: true,
      codexMode: codexConfig.mode,
      nativeEligible: true,
      hasRequiredAuth: true,
      state: "managed_only",
      inactiveReason: "tool_policy_denied",
    };
  }

  return {
    globalWebSearchEnabled,
    codexNativeEnabled: true,
    codexMode: codexConfig.mode,
    nativeEligible: true,
    hasRequiredAuth: true,
    state: "native_active",
  };
}

export function isNativeWebSearchAllowedByToolPolicy(
  params: NativeWebSearchToolPolicyParams,
): boolean {
  return resolveWebSearchToolPolicy(params).allowed;
}

/** Builds the OpenAI Responses `web_search` tool payload from config. */
export function buildCodexNativeWebSearchTool(
  config: OpenClawConfig | undefined,
  nativeWebSearch?: NativeWebSearchToolOptions,
): Record<string, unknown> {
  const nativeConfig = resolveCodexNativeWebSearchConfig(config);
  const tool: Record<string, unknown> = {
    type: "web_search",
    external_web_access: nativeConfig.mode === "live",
  };

  if (nativeConfig.allowedDomains) {
    tool.filters = {
      allowed_domains: nativeConfig.allowedDomains,
    };
  }

  const searchContextSize = nativeWebSearch?.searchContextSize ?? nativeConfig.contextSize;
  if (searchContextSize) {
    tool.search_context_size = searchContextSize;
  }

  const hasRequestUserLocation =
    nativeWebSearch !== undefined && Object.hasOwn(nativeWebSearch, "userLocation");
  const userLocation = hasRequestUserLocation
    ? nativeWebSearch.userLocation
    : nativeConfig.userLocation
      ? {
          type: "approximate",
          ...nativeConfig.userLocation,
        }
      : undefined;
  if (userLocation) {
    tool.user_location = userLocation;
  }

  return tool;
}

function applyCodexNativeWebSearchOptions(
  tool: Record<string, unknown>,
  nativeWebSearch: NativeWebSearchToolOptions | undefined,
): void {
  if (!nativeWebSearch) {
    return;
  }
  if (nativeWebSearch.searchContextSize) {
    tool.search_context_size = nativeWebSearch.searchContextSize;
  }
  if (nativeWebSearch.userLocation === null) {
    delete tool.user_location;
  } else if (nativeWebSearch.userLocation) {
    tool.user_location = nativeWebSearch.userLocation;
  }
}

/** Injects a native Codex web-search tool into a mutable provider payload. */
export function patchCodexNativeWebSearchPayload(params: {
  payload: unknown;
  config?: OpenClawConfig;
  nativeWebSearch?: NativeWebSearchToolOptions;
}): CodexNativeSearchPayloadPatchResult {
  if (!isRecord(params.payload)) {
    return { status: "payload_not_object" };
  }

  const payload = params.payload;
  const existingTool = Array.isArray(payload.tools)
    ? payload.tools.find((tool): tool is Record<string, unknown> => {
        return isRecord(tool) && tool.type === "web_search";
      })
    : undefined;
  if (existingTool) {
    applyCodexNativeWebSearchOptions(existingTool, params.nativeWebSearch);
    return { status: "native_tool_already_present" };
  }

  const tools = Array.isArray(payload.tools) ? [...payload.tools] : [];
  tools.push(buildCodexNativeWebSearchTool(params.config, params.nativeWebSearch));
  payload.tools = tools;
  return { status: "injected" };
}

/** Returns whether the managed OpenClaw web-search tool should be hidden. */
export function shouldSuppressManagedWebSearchTool(params: {
  config?: OpenClawConfig;
  modelProvider?: string;
  modelApi?: string;
  modelId?: string;
  agentId?: string;
  sessionKey?: string;
  sandboxToolPolicy?: SandboxToolPolicy;
  messageProvider?: string;
  agentAccountId?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  agentDir?: string;
}): boolean {
  return resolveCodexNativeSearchActivation(params).state === "native_active";
}
