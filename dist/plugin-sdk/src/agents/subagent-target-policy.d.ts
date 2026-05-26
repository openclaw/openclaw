type SubagentTargetPolicyResult = {
    ok: true;
} | {
    ok: false;
    allowedText: string;
    error: string;
};
export declare function resolveSubagentAllowedTargetIds(params: {
    requesterAgentId: string;
    allowAgents?: readonly string[];
    configuredAgentIds?: readonly string[];
}): {
    allowAny: boolean;
    allowedIds: string[];
};
export declare function resolveSubagentTargetPolicy(params: {
    requesterAgentId: string;
    targetAgentId: string;
    requestedAgentId?: string;
    allowAgents?: readonly string[];
}): SubagentTargetPolicyResult;
export {};
