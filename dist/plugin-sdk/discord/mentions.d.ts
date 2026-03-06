export declare function formatMention(params: {
    userId?: string | number | bigint | null;
    roleId?: string | number | bigint | null;
    channelId?: string | number | bigint | null;
}): string;
export declare function rewriteDiscordKnownMentions(text: string, params: {
    accountId?: string | null;
}): string;
