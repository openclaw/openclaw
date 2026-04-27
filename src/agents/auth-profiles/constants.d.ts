export { AUTH_PROFILE_FILENAME, AUTH_STATE_FILENAME, LEGACY_AUTH_FILENAME, } from "./path-constants.js";
export declare const AUTH_STORE_VERSION = 1;
export declare const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";
export declare const CODEX_CLI_PROFILE_ID = "openai-codex:codex-cli";
export declare const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai-codex:default";
export declare const MINIMAX_CLI_PROFILE_ID = "minimax-portal:minimax-cli";
export declare const AUTH_STORE_LOCK_OPTIONS: {
    readonly retries: {
        readonly retries: 10;
        readonly factor: 2;
        readonly minTimeout: 100;
        readonly maxTimeout: 10000;
        readonly randomize: true;
    };
    readonly stale: 30000;
};
export declare const OAUTH_REFRESH_LOCK_OPTIONS: {
    readonly retries: {
        readonly retries: 20;
        readonly factor: 2;
        readonly minTimeout: 100;
        readonly maxTimeout: 10000;
        readonly randomize: true;
    };
    readonly stale: 180000;
};
export declare const OAUTH_REFRESH_CALL_TIMEOUT_MS = 120000;
export declare const EXTERNAL_CLI_SYNC_TTL_MS: number;
export declare const EXTERNAL_CLI_NEAR_EXPIRY_MS: number;
export declare const log: import("../../logging/subsystem.js").SubsystemLogger;
