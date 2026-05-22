import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareProviderExtraParams as prepareProviderExtraParamsRuntime, resolveProviderExtraParamsForTransport as resolveProviderExtraParamsForTransportRuntime, wrapProviderStreamFn as wrapProviderStreamFnRuntime } from "../../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
declare const defaultProviderRuntimeDeps: {
    prepareProviderExtraParams: typeof prepareProviderExtraParamsRuntime;
    resolveProviderExtraParamsForTransport: typeof resolveProviderExtraParamsForTransportRuntime;
    wrapProviderStreamFn: typeof wrapProviderStreamFnRuntime;
};
export declare const __testing: {
    setProviderRuntimeDepsForTest(deps: Partial<typeof defaultProviderRuntimeDeps> | undefined): void;
    resetProviderRuntimeDepsForTest(): void;
};
/**
 * Resolve provider-specific extra params from model config.
 * Used to pass through stream params like temperature/maxTokens.
 *
 * @internal Exported for testing only
 */
export declare function resolveExtraParams(params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    modelId: string;
    agentId?: string;
}): Record<string, unknown> | undefined;
export type SupportedTransport = "sse" | "websocket" | "auto";
export declare function resolvePreparedExtraParams(params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    modelId: string;
    agentDir?: string;
    workspaceDir?: string;
    extraParamsOverride?: Record<string, unknown>;
    thinkingLevel?: ThinkLevel;
    agentId?: string;
    resolvedExtraParams?: Record<string, unknown>;
    model?: ProviderRuntimeModel;
    resolvedTransport?: SupportedTransport;
}): Record<string, unknown>;
export declare function resolveAgentTransportOverride(params: {
    settingsManager: Pick<SettingsManager, "getGlobalSettings" | "getProjectSettings">;
    effectiveExtraParams: Record<string, unknown> | undefined;
}): SupportedTransport | undefined;
export declare function resolveExplicitSettingsTransport(params: {
    settingsManager: Pick<SettingsManager, "getGlobalSettings" | "getProjectSettings">;
    sessionTransport: unknown;
}): SupportedTransport | undefined;
/**
 * Apply extra params (like temperature) to an agent's streamFn.
 * Also applies verified provider-specific request wrappers, such as OpenRouter attribution.
 *
 * @internal Exported for testing
 */
export declare function applyExtraParamsToAgent(agent: {
    streamFn?: StreamFn;
}, cfg: OpenClawConfig | undefined, provider: string, modelId: string, extraParamsOverride?: Record<string, unknown>, thinkingLevel?: ThinkLevel, agentId?: string, workspaceDir?: string, model?: ProviderRuntimeModel, agentDir?: string, resolvedTransport?: SupportedTransport, options?: {
    preparedExtraParams?: Record<string, unknown>;
}): {
    effectiveExtraParams: Record<string, unknown>;
};
export {};
