import { isRecord } from "../utils.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "./auth-profiles.js";
import { resolveCodexNativeWebSearchConfig } from "./codex-native-web-search.shared.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
export { describeCodexNativeWebSearch, resolveCodexNativeWebSearchConfig, } from "./codex-native-web-search.shared.js";
export function isCodexNativeSearchEligibleModel(params) {
    return params.modelProvider === "openai-codex" || params.modelApi === "openai-codex-responses";
}
export function hasCodexNativeWebSearchTool(tools) {
    if (!Array.isArray(tools)) {
        return false;
    }
    return tools.some((tool) => isRecord(tool) && typeof tool.type === "string" && tool.type === "web_search");
}
export function hasAvailableCodexAuth(params) {
    if (Object.values(params.config?.auth?.profiles ?? {}).some((profile) => isRecord(profile) && profile.provider === "openai-codex")) {
        return true;
    }
    if (params.agentDir) {
        try {
            if (listProfilesForProvider(ensureAuthProfileStore(params.agentDir), "openai-codex").length > 0) {
                return true;
            }
        }
        catch {
            // Fall back to config-based detection below.
        }
    }
    return false;
}
export function resolveCodexNativeSearchActivation(params) {
    const globalWebSearchEnabled = params.config?.tools?.web?.search?.enabled !== false;
    const codexConfig = resolveCodexNativeWebSearchConfig(params.config);
    const nativeEligible = isCodexNativeSearchEligibleModel(params);
    const hasRequiredAuth = params.modelProvider !== "openai-codex" || hasAvailableCodexAuth(params);
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
    return {
        globalWebSearchEnabled,
        codexNativeEnabled: true,
        codexMode: codexConfig.mode,
        nativeEligible: true,
        hasRequiredAuth: true,
        state: "native_active",
    };
}
export function buildCodexNativeWebSearchTool(config) {
    const nativeConfig = resolveCodexNativeWebSearchConfig(config);
    const tool = {
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
export function patchCodexNativeWebSearchPayload(params) {
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
export function shouldSuppressManagedWebSearchTool(params) {
    return resolveCodexNativeSearchActivation(params).state === "native_active";
}
export function isCodexNativeWebSearchRelevant(params) {
    if (resolveCodexNativeWebSearchConfig(params.config).enabled) {
        return true;
    }
    if (hasAvailableCodexAuth(params)) {
        return true;
    }
    const defaultModel = resolveDefaultModelForAgent({
        cfg: params.config,
        agentId: params.agentId,
    });
    const configuredProvider = params.config.models?.providers?.[defaultModel.provider];
    const configuredModelApi = configuredProvider?.models?.find((candidate) => candidate.id === defaultModel.model)?.api;
    return isCodexNativeSearchEligibleModel({
        modelProvider: defaultModel.provider,
        modelApi: configuredModelApi ?? configuredProvider?.api,
    });
}
