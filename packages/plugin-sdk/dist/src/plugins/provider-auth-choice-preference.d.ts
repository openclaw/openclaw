import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function resolvePreferredProviderForAuthChoice(params: {
    choice: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    includeUntrustedWorkspacePlugins?: boolean;
}): Promise<string | undefined>;
