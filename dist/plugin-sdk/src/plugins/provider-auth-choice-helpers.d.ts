import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthMethod, ProviderPlugin } from "./types.js";
export declare function resolveProviderMatch(providers: ProviderPlugin[], rawProvider?: string): ProviderPlugin | null;
export declare function pickAuthMethod(provider: ProviderPlugin, rawMethod?: string): ProviderAuthMethod | null;
export declare function applyProviderAuthConfigPatch(cfg: OpenClawConfig, patch: unknown, options?: {
    replaceDefaultModels?: boolean;
}): OpenClawConfig;
/**
 * Restore `agents.defaults.model` after a provider auth config merge when the user did not pass
 * `--set-default`, so `applyConfig` patches cannot replace the primary without an explicit opt-in.
 */
export declare function restorePriorAgentsDefaultsModelUnlessOptIn(params: {
    cfg: OpenClawConfig;
    priorAgentsDefaultsModel?: AgentModelConfig;
    setDefault?: boolean;
}): OpenClawConfig;
export declare function applyDefaultModel(cfg: OpenClawConfig, model: string, opts?: {
    preserveExistingPrimary?: boolean;
}): OpenClawConfig;
