export type DiscordPluralKitConfig = {
    enabled?: boolean;
    token?: string;
};
export type PluralKitSystemInfo = {
    id: string;
    name?: string | null;
    tag?: string | null;
};
export type PluralKitMemberInfo = {
    id: string;
    name?: string | null;
    display_name?: string | null;
};
export type PluralKitMessageInfo = {
    id: string;
    original?: string | null;
    sender?: string | null;
    system?: PluralKitSystemInfo | null;
    member?: PluralKitMemberInfo | null;
};
export declare function fetchPluralKitMessageInfo(params: {
    messageId: string;
    config?: DiscordPluralKitConfig;
    fetcher?: typeof fetch;
}): Promise<PluralKitMessageInfo | null>;
