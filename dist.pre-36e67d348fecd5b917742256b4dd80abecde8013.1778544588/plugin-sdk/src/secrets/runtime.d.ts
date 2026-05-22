import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { type OpenClawConfig } from "../config/config.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { type SecretResolverWarning } from "./runtime-shared.js";
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.js";
export type { SecretResolverWarning } from "./runtime-shared.js";
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
export declare function prepareSecretsRuntimeSnapshot(params: {
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    agentDirs?: string[];
    includeAuthStoreRefs?: boolean;
    loadAuthStore?: (agentDir?: string) => AuthProfileStore;
    /** Test override for discovered loadable plugins and their origins. */
    loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): Promise<PreparedSecretsRuntimeSnapshot>;
export declare function activateSecretsRuntimeSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): void;
export declare function getActiveSecretsRuntimeSnapshot(): PreparedSecretsRuntimeSnapshot | null;
export declare function getActiveRuntimeWebToolsMetadata(): RuntimeWebToolsMetadata | null;
export declare function clearSecretsRuntimeSnapshot(): void;
