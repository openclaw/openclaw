import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type CodexNativeSearchMode } from "./codex-native-web-search.shared.js";
type CodexNativeSearchActivation = {
    globalWebSearchEnabled: boolean;
    codexNativeEnabled: boolean;
    codexMode: CodexNativeSearchMode;
    nativeEligible: boolean;
    hasRequiredAuth: boolean;
    state: "managed_only" | "native_active";
    inactiveReason?: "globally_disabled" | "codex_not_enabled" | "model_not_eligible" | "codex_auth_missing";
};
type CodexNativeSearchPayloadPatchResult = {
    status: "payload_not_object" | "native_tool_already_present" | "injected";
};
export declare function isCodexNativeSearchEligibleModel(params: {
    modelProvider?: string;
    modelApi?: string;
}): boolean;
export declare function hasAvailableCodexAuth(params: {
    config?: OpenClawConfig;
    agentDir?: string;
}): boolean;
export declare function resolveCodexNativeSearchActivation(params: {
    config?: OpenClawConfig;
    modelProvider?: string;
    modelApi?: string;
    agentDir?: string;
}): CodexNativeSearchActivation;
export declare function buildCodexNativeWebSearchTool(config: OpenClawConfig | undefined): Record<string, unknown>;
export declare function patchCodexNativeWebSearchPayload(params: {
    payload: unknown;
    config?: OpenClawConfig;
}): CodexNativeSearchPayloadPatchResult;
export declare function shouldSuppressManagedWebSearchTool(params: {
    config?: OpenClawConfig;
    modelProvider?: string;
    modelApi?: string;
    agentDir?: string;
}): boolean;
export {};
