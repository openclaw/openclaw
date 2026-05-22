import type { OpenClawConfig } from "../config/types.openclaw.js";
type CommandSecretTargetScope = {
    targetIds: Set<string>;
    allowedPaths?: Set<string>;
    forcedActivePaths?: Set<string>;
    optionalActivePaths?: Set<string>;
};
export declare function getScopedChannelsCommandSecretTargets(params: {
    config: OpenClawConfig;
    channel?: string | null;
    accountId?: string | null;
}): {
    targetIds: Set<string>;
    allowedPaths?: Set<string>;
};
export declare function getQrRemoteCommandSecretTargetIds(): Set<string>;
export declare function getChannelsCommandSecretTargetIds(): Set<string>;
export declare function getConfiguredChannelsCommandSecretTargetIds(config: OpenClawConfig, env?: NodeJS.ProcessEnv): Set<string>;
export declare function getModelsCommandSecretTargetIds(): Set<string>;
export declare function getMemoryEmbeddingCommandSecretTargetIds(): Set<string>;
export declare function getTtsCommandSecretTargetIds(): Set<string>;
export declare function getAgentRuntimeCommandSecretTargetIds(params?: {
    includeChannelTargets?: boolean;
}): Set<string>;
export declare function getCapabilityWebFetchCommandSecretTargetIds(): Set<string>;
export declare function getCapabilityWebFetchCommandSecretTargets(config: OpenClawConfig, options?: {
    providerId?: string | null;
}): CommandSecretTargetScope;
export declare function getCapabilityWebSearchCommandSecretTargetIds(): Set<string>;
export declare function getCapabilityWebSearchCommandSecretTargets(config: OpenClawConfig, options?: {
    providerId?: string | null;
}): CommandSecretTargetScope;
export declare function getStatusCommandSecretTargetIds(config?: OpenClawConfig, env?: NodeJS.ProcessEnv): Set<string>;
export declare function getSecurityAuditCommandSecretTargetIds(): Set<string>;
export {};
