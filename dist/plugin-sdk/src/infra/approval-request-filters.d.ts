export type ApprovalRequestFilterInput = {
    agentId?: string | null;
    sessionKey?: string | null;
};
export declare function matchesApprovalRequestSessionFilter(sessionKey: string, patterns: string[]): boolean;
export declare function matchesApprovalRequestFilters(params: {
    request: ApprovalRequestFilterInput;
    agentFilter?: string[];
    sessionFilter?: string[];
    fallbackAgentIdFromSessionKey?: boolean;
}): boolean;
