export declare function isLegacyGroupSessionKey(key: string): boolean;
export declare function deriveLegacySessionChatType(key: string): "group" | undefined;
export declare function canonicalizeLegacySessionKey(params: {
    key: string;
    agentId: string;
}): string | null;
