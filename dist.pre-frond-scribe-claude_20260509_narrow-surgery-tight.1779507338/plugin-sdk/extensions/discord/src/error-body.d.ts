export declare function summarizeDiscordResponseBody(body: string, opts?: {
    emptyText?: string;
}): string | undefined;
export declare function isDiscordHtmlResponseBody(body: string, contentType?: string | null): boolean;
export declare function isDiscordRateLimitResponseBody(body: string): boolean;
