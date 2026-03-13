export declare function rememberDiscordDirectoryUser(params: {
    accountId?: string | null;
    userId: string | number | bigint;
    handles: Array<string | null | undefined>;
}): void;
export declare function resolveDiscordDirectoryUserId(params: {
    accountId?: string | null;
    handle: string;
}): string | undefined;
export declare function __resetDiscordDirectoryCacheForTest(): void;
