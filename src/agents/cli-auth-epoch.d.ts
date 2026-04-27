import { loadAuthProfileStoreForRuntime } from "./auth-profiles/store.js";
import { readClaudeCliCredentialsCached, readCodexCliCredentialsCached, readGeminiCliCredentialsCached } from "./cli-credentials.js";
type CliAuthEpochDeps = {
    readClaudeCliCredentialsCached: typeof readClaudeCliCredentialsCached;
    readCodexCliCredentialsCached: typeof readCodexCliCredentialsCached;
    readGeminiCliCredentialsCached: typeof readGeminiCliCredentialsCached;
    loadAuthProfileStoreForRuntime: typeof loadAuthProfileStoreForRuntime;
};
export declare const CLI_AUTH_EPOCH_VERSION = 4;
export declare function setCliAuthEpochTestDeps(overrides: Partial<CliAuthEpochDeps>): void;
export declare function resetCliAuthEpochTestDeps(): void;
export declare function resolveCliAuthEpoch(params: {
    provider: string;
    authProfileId?: string;
    skipLocalCredential?: boolean;
}): Promise<string | undefined>;
export {};
