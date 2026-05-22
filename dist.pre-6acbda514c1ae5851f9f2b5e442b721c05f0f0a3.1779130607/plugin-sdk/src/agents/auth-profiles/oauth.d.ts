import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileCredential, AuthProfileStore, OAuthCredential } from "./types.js";
export { isSafeToCopyOAuthIdentity, isSameOAuthIdentity, normalizeAuthEmailToken, normalizeAuthIdentityToken, shouldMirrorRefreshedOAuthCredential, } from "./oauth-identity.js";
export type { OAuthMirrorDecision, OAuthMirrorDecisionReason } from "./oauth-identity.js";
type ResolveApiKeyForProfileResult = {
    apiKey: string;
    provider: string;
    email?: string;
    profileId: string;
    profileType: AuthProfileCredential["type"];
};
export declare function isRefreshTokenReusedError(error: unknown): boolean;
type ResolveApiKeyForProfileParams = {
    cfg?: OpenClawConfig;
    store: AuthProfileStore;
    profileId: string;
    agentDir?: string;
    forceRefresh?: boolean;
};
export declare function refreshOAuthCredentialForRuntime(params: {
    credential: OAuthCredential;
}): Promise<OAuthCredential | null>;
export declare function resetOAuthRefreshQueuesForTest(): void;
export declare function resolveApiKeyForProfile(params: ResolveApiKeyForProfileParams): Promise<ResolveApiKeyForProfileResult | null>;
