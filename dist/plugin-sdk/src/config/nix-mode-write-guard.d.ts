export declare const NIX_OPENCLAW_AGENT_FIRST_URL = "https://github.com/openclaw/nix-openclaw#quick-start";
export declare const OPENCLAW_NIX_OVERVIEW_URL = "https://docs.openclaw.ai/install/nix";
export declare class NixModeConfigMutationError extends Error {
    readonly code = "OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE";
    constructor(params?: {
        configPath?: string;
    });
}
export declare function formatNixModeConfigMutationMessage(params?: {
    configPath?: string;
}): string;
export declare function assertConfigWriteAllowedInCurrentMode(params?: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
}): void;
