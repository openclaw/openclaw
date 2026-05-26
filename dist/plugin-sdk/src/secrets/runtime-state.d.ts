import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { type RuntimeConfigSnapshotRefreshHandler } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import type { SecretResolverWarning } from "./runtime-shared.js";
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.types.js";
export type PreparedSecretsRuntimeSnapshot = {
    sourceConfig: OpenClawConfig;
    config: OpenClawConfig;
    authStores: Array<{
        agentDir: string;
        store: AuthProfileStore;
    }>;
    warnings: SecretResolverWarning[];
    webTools: RuntimeWebToolsMetadata;
};
export type SecretsRuntimeRefreshContext = {
    env: Record<string, string | undefined>;
    explicitAgentDirs: string[] | null;
    includeAuthStoreRefs: boolean;
    loadAuthStore?: (agentDir?: string) => AuthProfileStore;
    loadablePluginOrigins: ReadonlyMap<string, PluginOrigin>;
};
export declare function cloneSecretsRuntimeRefreshContext(context: SecretsRuntimeRefreshContext): SecretsRuntimeRefreshContext;
export declare function setPreparedSecretsRuntimeSnapshotRefreshContext(snapshot: PreparedSecretsRuntimeSnapshot, context: SecretsRuntimeRefreshContext): void;
export declare function getPreparedSecretsRuntimeSnapshotRefreshContext(snapshot: PreparedSecretsRuntimeSnapshot): SecretsRuntimeRefreshContext | null;
export declare function getActiveSecretsRuntimeRefreshContext(): SecretsRuntimeRefreshContext | null;
export declare function getActiveSecretsRuntimeEnv(): NodeJS.ProcessEnv;
export declare function registerSecretsRuntimeStateClearHook(clearHook: () => void): void;
export declare function activateSecretsRuntimeSnapshotState(params: {
    snapshot: PreparedSecretsRuntimeSnapshot;
    refreshContext: SecretsRuntimeRefreshContext | null;
    refreshHandler: RuntimeConfigSnapshotRefreshHandler | null;
}): void;
export declare function getActiveSecretsRuntimeSnapshot(): PreparedSecretsRuntimeSnapshot | null;
export declare function getLiveSecretsRuntimeAuthStores(): PreparedSecretsRuntimeSnapshot["authStores"];
export declare function clearSecretsRuntimeSnapshot(): void;
