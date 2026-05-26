import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function buildProviderAuthRecoveryHint(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    includeConfigure?: boolean;
    includeEnvVar?: boolean;
}): string;
