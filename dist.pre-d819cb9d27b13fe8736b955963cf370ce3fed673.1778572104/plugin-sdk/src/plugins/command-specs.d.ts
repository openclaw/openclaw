import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function getPluginCommandSpecs(provider?: string, options?: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    workspaceDir?: string;
    config?: OpenClawConfig;
}): Array<{
    name: string;
    description: string;
    descriptionLocalizations?: Record<string, string>;
    acceptsArgs: boolean;
}>;
/** Resolve plugin command specs for a provider's native naming surface without support gating. */
export declare function listProviderPluginCommandSpecs(provider?: string): Array<{
    name: string;
    description: string;
    descriptionLocalizations?: Record<string, string>;
    acceptsArgs: boolean;
}>;
