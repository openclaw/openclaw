export type NodeMatchCandidate = {
    nodeId: string;
    displayName?: string;
    remoteIp?: string;
    connected?: boolean;
};
export declare function normalizeNodeKey(value: string): string;
export declare function resolveNodeMatches(nodes: NodeMatchCandidate[], query: string): NodeMatchCandidate[];
export declare function resolveNodeIdFromCandidates(nodes: NodeMatchCandidate[], query: string): string;
