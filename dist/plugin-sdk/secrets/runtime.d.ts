import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { type OpenClawConfig } from "../config/config.js";
import { type CommandSecretAssignment } from "./command-config.js";
import { type SecretResolverWarning } from "./runtime-shared.js";
import { type RuntimeWebToolsMetadata } from "./runtime-web-tools.js";
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
    loadAuthStore?: (agentDir?: string) => AuthProfileStore;
}): Promise<PreparedSecretsRuntimeSnapshot>;
export declare function activateSecretsRuntimeSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): void;
export declare function getActiveSecretsRuntimeSnapshot(): PreparedSecretsRuntimeSnapshot | null;
export declare function getActiveRuntimeWebToolsMetadata(): RuntimeWebToolsMetadata | null;
export declare function resolveCommandSecretsFromActiveRuntimeSnapshot(params: {
    commandName: string;
    targetIds: ReadonlySet<string>;
}): {
    assignments: CommandSecretAssignment[];
    diagnostics: string[];
    inactiveRefPaths: string[];
};
export declare function clearSecretsRuntimeSnapshot(): void;
