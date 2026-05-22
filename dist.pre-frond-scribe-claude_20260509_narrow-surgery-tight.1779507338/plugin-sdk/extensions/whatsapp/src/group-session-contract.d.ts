export declare function resolveLegacyGroupSessionKey(ctx: {
    From?: string;
}): {
    key: string;
    channel: string;
    id: string;
    chatType: "group";
} | null;
