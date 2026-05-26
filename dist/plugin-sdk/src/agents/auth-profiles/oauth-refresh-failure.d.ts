export type OAuthRefreshFailureReason = "refresh_token_reused" | "invalid_grant" | "sign_in_again" | "invalid_refresh_token" | "revoked";
export declare function classifyOAuthRefreshFailureReason(message: string): OAuthRefreshFailureReason | null;
export declare function classifyOAuthRefreshFailure(message: string): {
    provider: string | null;
    reason: OAuthRefreshFailureReason | null;
} | null;
export declare function buildOAuthRefreshFailureLoginCommand(provider: string | null | undefined): string;
