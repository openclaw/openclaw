import type { OpenClawConfig } from "../config/types.js";
export declare function shouldSkipStatusScanMissingConfigFastPath(env?: NodeJS.ProcessEnv): boolean;
export declare function resolveStatusScanColdStart(params?: {
    env?: NodeJS.ProcessEnv;
    allowMissingConfigFastPath?: boolean;
}): boolean;
export declare function loadStatusScanCommandConfig(params: {
    commandName: string;
    readBestEffortConfig: () => Promise<OpenClawConfig>;
    resolveConfig: (sourceConfig: OpenClawConfig) => Promise<{
        resolvedConfig: OpenClawConfig;
        diagnostics: string[];
    }>;
    env?: NodeJS.ProcessEnv;
    allowMissingConfigFastPath?: boolean;
}): Promise<{
    coldStart: boolean;
    sourceConfig: OpenClawConfig;
    resolvedConfig: OpenClawConfig;
    secretDiagnostics: string[];
}>;
