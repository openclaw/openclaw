import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";
type ImplicitProviderParams = {
    agentDir: string;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    explicitProviders?: Record<string, ProviderConfig> | null;
};
export declare function resolveProviderDiscoveryFilterForTest(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env: NodeJS.ProcessEnv;
}): string[] | undefined;
export declare function resolveImplicitProviders(params: ImplicitProviderParams): Promise<NonNullable<OpenClawConfig["models"]>["providers"]>;
export {};
