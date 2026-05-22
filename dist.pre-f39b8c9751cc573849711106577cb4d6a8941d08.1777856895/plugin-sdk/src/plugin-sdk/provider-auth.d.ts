import type { OpenClawConfig } from "../config/config.js";
export type { OpenClawConfig } from "../config/config.js";
export type { SecretInput } from "../config/types.secrets.js";
export type { SecretInputMode } from "../plugins/provider-auth-types.js";
export type { ProviderAuthResult } from "../plugins/types.js";
export type { ProviderAuthContext } from "../plugins/types.js";
export type { AuthProfileStore, OAuthCredential } from "../agents/auth-profiles/types.js";
export { CLAUDE_CLI_PROFILE_ID, CODEX_CLI_PROFILE_ID } from "../agents/auth-profiles/constants.js";
export { ensureAuthProfileStore, ensureAuthProfileStoreForLocalUpdate, updateAuthProfileStoreWithLock, } from "../agents/auth-profiles/store.js";
export { listProfilesForProvider, removeProviderAuthProfilesWithLock, upsertAuthProfile, upsertAuthProfileWithLock, } from "../agents/auth-profiles/profiles.js";
export { resolveEnvApiKey } from "../agents/model-auth-env.js";
export { readClaudeCliCredentialsCached } from "../agents/cli-credentials.js";
export { suggestOAuthProfileIdForLegacyDefault } from "../agents/auth-profiles/repair.js";
export { CUSTOM_LOCAL_AUTH_MARKER, MINIMAX_OAUTH_MARKER, isKnownEnvApiKeyMarker, isNonSecretApiKeyMarker, resolveOAuthApiKeyMarker, resolveNonEnvSecretRefApiKeyMarker, } from "../agents/model-auth-markers.js";
export { formatApiKeyPreview, normalizeApiKeyInput, validateApiKeyInput, } from "../plugins/provider-auth-input.js";
export { ensureApiKeyFromEnvOrPrompt, ensureApiKeyFromOptionEnvOrPrompt, normalizeSecretInputModeInput, promptSecretRefForSetup, resolveSecretInputModeForEnvSelection, } from "../plugins/provider-auth-input.js";
export { normalizeApiKeyConfig } from "../agents/models-config.providers.secrets.js";
export { buildTokenProfileId, validateAnthropicSetupToken, } from "../plugins/provider-auth-token.js";
export { applyAuthProfileConfig, buildApiKeyCredential, upsertApiKeyProfile, writeOAuthCredentials, type ApiKeyStorageOptions, type WriteOAuthCredentialsOptions, } from "../plugins/provider-auth-helpers.js";
export { createProviderApiKeyAuthMethod } from "../plugins/provider-api-key-auth.js";
export { coerceSecretRef, hasConfiguredSecretInput } from "../config/types.secrets.js";
export { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";
export { resolveRequiredHomeDir } from "../infra/home-dir.js";
export { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
export { normalizeOptionalSecretInput, normalizeSecretInput, } from "../utils/normalize-secret-input.js";
export { listKnownProviderAuthEnvVarNames, omitEnvKeysCaseInsensitive, } from "../secrets/provider-env-vars.js";
export { buildOauthProviderAuthResult } from "./provider-auth-result.js";
export { generateHexPkceVerifierChallenge, generatePkceVerifierChallenge, toFormUrlEncoded, } from "./oauth-utils.js";
export { DEFAULT_OAUTH_REFRESH_MARGIN_MS, hasUsableOAuthCredential, } from "../agents/auth-profiles/credential-state.js";
export declare const COPILOT_EDITOR_VERSION = "vscode/1.96.2";
export declare const COPILOT_USER_AGENT = "GitHubCopilotChat/0.26.7";
export declare const COPILOT_EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
export declare const COPILOT_GITHUB_API_VERSION = "2025-04-01";
export declare const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";
export type CachedCopilotToken = {
    token: string;
    expiresAt: number;
    updatedAt: number;
};
export declare function buildCopilotIdeHeaders(params?: {
    includeApiVersion?: boolean;
}): Record<string, string>;
export declare function deriveCopilotApiBaseUrlFromToken(token: string): string | null;
export declare function resolveCopilotApiToken(params: {
    githubToken: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    cachePath?: string;
    loadJsonFileImpl?: (path: string) => unknown;
    saveJsonFileImpl?: (path: string, value: CachedCopilotToken) => void;
}): Promise<{
    token: string;
    expiresAt: number;
    source: string;
    baseUrl: string;
}>;
export declare function isProviderApiKeyConfigured(params: {
    provider: string;
    agentDir?: string;
}): boolean;
export declare function listUsableProviderAuthProfileIds(params: {
    provider: string;
    cfg?: OpenClawConfig;
    agentDir?: string;
}): {
    agentDir: string;
    profileIds: string[];
};
export declare function isProviderAuthProfileConfigured(params: {
    provider: string;
    cfg?: OpenClawConfig;
    agentDir?: string;
}): boolean;
export declare function resolveProviderAuthProfileApiKey(params: {
    provider: string;
    cfg?: OpenClawConfig;
    agentDir?: string;
}): Promise<string | undefined>;
