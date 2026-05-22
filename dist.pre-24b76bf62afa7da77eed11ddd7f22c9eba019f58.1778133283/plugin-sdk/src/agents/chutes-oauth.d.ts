import type { OAuthCredentials } from "@mariozechner/pi-ai";
export declare const CHUTES_AUTHORIZE_ENDPOINT = "https://api.chutes.ai/idp/authorize";
export declare const CHUTES_TOKEN_ENDPOINT = "https://api.chutes.ai/idp/token";
export declare const CHUTES_USERINFO_ENDPOINT = "https://api.chutes.ai/idp/userinfo";
type ChutesPkce = {
    verifier: string;
    challenge: string;
};
export type ChutesOAuthAppConfig = {
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    scopes: string[];
};
type ChutesStoredOAuth = OAuthCredentials & {
    clientId?: string;
};
export declare function generateChutesPkce(): ChutesPkce;
export declare function parseOAuthCallbackInput(input: string, expectedState: string): {
    code: string;
    state: string;
} | {
    error: string;
};
export declare function exchangeChutesCodeForTokens(params: {
    app: ChutesOAuthAppConfig;
    code: string;
    codeVerifier: string;
    fetchFn?: typeof fetch;
    now?: number;
}): Promise<ChutesStoredOAuth>;
export declare function refreshChutesTokens(params: {
    credential: ChutesStoredOAuth;
    fetchFn?: typeof fetch;
    now?: number;
}): Promise<ChutesStoredOAuth>;
export {};
