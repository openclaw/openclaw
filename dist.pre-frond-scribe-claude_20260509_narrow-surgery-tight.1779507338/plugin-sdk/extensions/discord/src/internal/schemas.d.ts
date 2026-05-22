export declare function assertDiscordInteractionPayload(value: unknown): void;
export declare function isDiscordRateLimitBody(value: unknown): value is {
    message?: string;
    retry_after?: number | string;
    global?: boolean;
    code?: number | string;
};
