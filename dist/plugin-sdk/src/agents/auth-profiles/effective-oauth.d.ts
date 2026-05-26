import type { OAuthCredential } from "./types.js";
export declare function resolveEffectiveOAuthCredential(params: {
    profileId: string;
    credential: OAuthCredential;
}): OAuthCredential;
