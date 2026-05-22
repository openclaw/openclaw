import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import type { PreparedSecretsRuntimeSnapshot, SecretsRuntimeRefreshContext } from "./runtime-state.js";
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.types.js";
export declare function mergeSecretsRuntimeEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined): Record<string, string | undefined>;
export declare function collectCandidateAgentDirs(config: OpenClawConfig, env?: NodeJS.ProcessEnv | Record<string, string | undefined>): string[];
export declare function resolveRefreshAgentDirs(config: OpenClawConfig, context: SecretsRuntimeRefreshContext): string[];
export declare function hasCandidateAuthProfileStoreSources(params: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv | Record<string, string | undefined>;
    agentDirs?: string[];
}): boolean;
export declare function createEmptyRuntimeWebToolsMetadata(): RuntimeWebToolsMetadata;
export declare function canUseSecretsRuntimeFastPath(params: {
    sourceConfig: OpenClawConfig;
    authStores: Array<{
        agentDir: string;
        store: AuthProfileStore;
    }>;
}): boolean;
export declare function prepareSecretsRuntimeFastPathSnapshot(params: {
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    agentDirs?: string[];
    includeAuthStoreRefs?: boolean;
    loadAuthStore?: (agentDir?: string) => AuthProfileStore;
    loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): {
    snapshot: PreparedSecretsRuntimeSnapshot;
    refreshContext: SecretsRuntimeRefreshContext;
    usesAuthStoreFallback: boolean;
} | null;
