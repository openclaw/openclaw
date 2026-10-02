/**
 * Activates and injects OpenAI/Codex native web-search tools when config,
 * model API, and auth state allow it.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";
import { externalCliDiscoveryForProviderAuth } from "./auth-profiles/external-cli-discovery.js";
import { listProfilesForProvider } from "./auth-profiles/profile-list.js";
import { ensureAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  type CodexNativeSearchMode,
  resolveCodexNativeWebSearchConfig,
} from "./codex-native-web-search.shared.js";
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
    | "managed_provider_selected"
    | "model_not_eligible"
    | "codex_auth_missing"
    | "tool_policy_denied";
};

type CodexNativeSearchPayloadPatchResult = {
  status: "payload_not_object" | "native_tool_already_present" | "injected";
};

export type NativeWebSearchToolPolicyParams = WebSearchToolPolicyParams;

function isOpenAIAuthProviderId(provider: string | undefined): boolean {
  return provider === "openai";
}

/** Returns whether a model API can accept the native Codex web_search tool. */
export function isCodexNativeSearchEligibleModel(params: {
  modelProvider?: string;
  modelApi?: string;
}): boolean {
  return params.modelApi === "openai-chatgpt-responses";
}

function hasCodexNativeWebSearchTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) {
    return false;
  }
  return tools.some(
    (tool) => isRecord(tool) && typeof tool.type === "string" && tool.type === "web_search",
  );
}

/** Checks whether OpenAI/Codex auth is available for native web search. */
export function hasAvailableCodexAuth(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
}): boolean {
  if (params.authStore) {
    return listProfilesForProvider(params.authStore, "openai").length > 0;
  }
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
      if (listProfilesForProvider(store, "openai").length > 0) {
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
  webSearchEnabled?: boolean;
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
  authStore?: AuthProfileStore;
}): CodexNativeSearchActivation {
  const globalWebSearchEnabled =
    params.webSearchEnabled !== false && params.config?.tools?.web?.search?.enabled !== false;
  const codexConfig = resolveCodexNativeWebSearchConfig(params.config);
  const nativeEligible = isCodexNativeSearchEligibleModel(params);
  const hasRequiredAuth =
    params.modelApi !== "openai-chatgpt-responses" ||
    !isOpenAIAuthProviderId(params.modelProvider) ||
    hasAvailableCodexAuth(params);
  const searchProvider = params.config?.tools?.web?.search?.provider?.trim().toLowerCase();
  const managedProviderSelected = Boolean(
    searchProvider && searchProvider !== "auto" && searchProvider !== "openai",
  );
  const inactiveReason = !globalWebSearchEnabled
    ? "globally_disabled"
    : !codexConfig.enabled
      ? "codex_not_enabled"
      : managedProviderSelected
        ? "managed_provider_selected"
        : !nativeEligible
          ? "model_not_eligible"
          : !hasRequiredAuth
            ? "codex_auth_missing"
            : !isNativeWebSearchAllowedByToolPolicy(params)
              ? "tool_policy_denied"
              : undefined;

  return {
    globalWebSearchEnabled,
    codexNativeEnabled: codexConfig.enabled,
    codexMode: codexConfig.mode,
    nativeEligible,
    hasRequiredAuth,
    state: inactiveReason ? "managed_only" : "native_active",
    ...(inactiveReason ? { inactiveReason } : {}),
  };
}

export function isNativeWebSearchAllowedByToolPolicy(
  params: NativeWebSearchToolPolicyParams,
): boolean {
  return resolveWebSearchToolPolicy(params).allowed;
}

/** Builds the OpenAI Responses `web_search` tool payload from config. */
function buildCodexNativeWebSearchTool(
  config: OpenClawConfig | undefined,
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

  if (nativeConfig.contextSize) {
    tool.search_context_size = nativeConfig.contextSize;
  }

  if (nativeConfig.userLocation) {
    tool.user_location = {
      type: "approximate",
      ...nativeConfig.userLocation,
    };
  }

  return tool;
}

/** Injects a native Codex web-search tool into a mutable provider payload. */
export function patchCodexNativeWebSearchPayload(params: {
  payload: unknown;
  config?: OpenClawConfig;
}): CodexNativeSearchPayloadPatchResult {
  if (!isRecord(params.payload)) {
    return { status: "payload_not_object" };
  }

  const payload = params.payload;
  if (hasCodexNativeWebSearchTool(payload.tools)) {
    return { status: "native_tool_already_present" };
  }

  const tools = Array.isArray(payload.tools) ? [...payload.tools] : [];
  tools.push(buildCodexNativeWebSearchTool(params.config));
  payload.tools = tools;
  return { status: "injected" };
}
