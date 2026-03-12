export type AllowlistMatchSource = "wildcard" | "id" | "name" | "tag" | "username" | "prefixed-id" | "prefixed-user" | "prefixed-name" | "slug" | "localpart";
export type AllowlistMatch<TSource extends string = AllowlistMatchSource> = {
    allowed: boolean;
    matchKey?: string;
    matchSource?: TSource;
};
export declare function formatAllowlistMatchMeta(match?: {
    matchKey?: string;
    matchSource?: string;
} | null): string;
export declare function resolveAllowlistMatchSimple(params: {
    allowFrom: Array<string | number>;
    senderId: string;
    senderName?: string | null;
    allowNameMatching?: boolean;
}): AllowlistMatch<"wildcard" | "id" | "name">;
