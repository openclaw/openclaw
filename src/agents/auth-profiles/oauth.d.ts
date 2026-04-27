import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "./types.js";
export { isSafeToCopyOAuthIdentity, isSameOAuthIdentity, normalizeAuthEmailToken, normalizeAuthIdentityToken, shouldMirrorRefreshedOAuthCredential, } from "./oauth-identity.js";
export type { OAuthMirrorDecision, OAuthMirrorDecisionReason } from "./oauth-identity.js";
export declare function isRefreshTokenReusedError(error: unknown): boolean;
type ResolveApiKeyForProfileParams = {
    cfg?: OpenClawConfig;
    store: AuthProfileStore;
    profileId: string;
    agentDir?: string;
};
export declare function resetOAuthRefreshQueuesForTest(): void;
export declare function resolveApiKeyForProfile(params: ResolveApiKeyForProfileParams): Promise<{
    apiKey: string;
    provider: string;
    email?: string;
} | null>;
