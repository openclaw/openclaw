export declare function noteGroupMember(groupMemberNames: Map<string, Map<string, string>>, conversationId: string, e164?: string, name?: string): void;
export declare function formatGroupMembers(params: {
    participants: string[] | undefined;
    roster: Map<string, string> | undefined;
    fallbackE164?: string;
}): string | undefined;
