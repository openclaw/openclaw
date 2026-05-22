type DiscordDeployRateLimitDetails = {
    status?: number;
    retryAfterMs?: number;
    scope?: string;
    discordCode?: number | string;
};
export declare function attachDiscordDeployRequestBody(err: unknown, body: unknown): void;
export declare function attachDiscordDeployRestContext(err: unknown, context: {
    method: string;
    path: string;
    requestMs: number;
    timeoutMs?: number;
}): void;
export declare function formatDiscordDeployErrorMessage(err: unknown): string;
export declare function resolveDiscordDeployRateLimitDetails(err: unknown): DiscordDeployRateLimitDetails | undefined;
export declare function formatDiscordDeployRateLimitDetails(err: unknown): string;
export declare function formatDiscordDeployRateLimitWarning(err: unknown, accountId: string): string | undefined;
export declare function formatDiscordDeployErrorDetails(err: unknown): string;
export declare function isDiscordDeployDailyCreateLimit(err: unknown): boolean;
export {};
