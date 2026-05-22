export declare function readDiscordCode(body: unknown): number | undefined;
export declare function readDiscordMessage(body: unknown, fallback: string): string;
export declare function readRetryAfter(body: unknown, response: Response, fallbackSeconds?: number): number;
export declare class DiscordError extends Error {
    readonly status: number;
    readonly statusCode: number;
    readonly rawBody: unknown;
    readonly rawError: unknown;
    discordCode?: number;
    constructor(response: Response, body: unknown);
}
export declare class RateLimitError extends DiscordError {
    readonly retryAfter: number;
    readonly scope: string | null;
    readonly bucket: string | null;
    constructor(response: Response, body: {
        message: string;
        retry_after: number;
        global: boolean;
        code?: number | string;
    });
}
