type NodePairingNodeMetadata = {
    nodeId: string;
    displayName?: string;
    platform?: string;
    version?: string;
    coreVersion?: string;
    uiVersion?: string;
    deviceFamily?: string;
    modelIdentifier?: string;
    caps?: string[];
    commands?: string[];
    permissions?: Record<string, boolean>;
    remoteIp?: string;
};
export type NodePairingPendingRequest = NodePairingNodeMetadata & {
    requestId: string;
    silent?: boolean;
    isRepair?: boolean;
    ts: number;
};
export type NodePairingPairedNode = Omit<NodePairingNodeMetadata, "requestId"> & {
    token: string;
    bins?: string[];
    createdAtMs: number;
    approvedAtMs: number;
    lastConnectedAtMs?: number;
};
export type NodePairingList = {
    pending: NodePairingPendingRequest[];
    paired: NodePairingPairedNode[];
};
export declare function listNodePairing(baseDir?: string): Promise<NodePairingList>;
export declare function getPairedNode(nodeId: string, baseDir?: string): Promise<NodePairingPairedNode | null>;
export declare function requestNodePairing(req: Omit<NodePairingPendingRequest, "requestId" | "ts" | "isRepair">, baseDir?: string): Promise<{
    status: "pending";
    request: NodePairingPendingRequest;
    created: boolean;
}>;
export declare function approveNodePairing(requestId: string, baseDir?: string): Promise<{
    requestId: string;
    node: NodePairingPairedNode;
} | null>;
export declare function rejectNodePairing(requestId: string, baseDir?: string): Promise<{
    requestId: string;
    nodeId: string;
} | null>;
export declare function verifyNodeToken(nodeId: string, token: string, baseDir?: string): Promise<{
    ok: boolean;
    node?: NodePairingPairedNode;
}>;
export declare function updatePairedNodeMetadata(nodeId: string, patch: Partial<Omit<NodePairingPairedNode, "nodeId" | "token" | "createdAtMs" | "approvedAtMs">>, baseDir?: string): Promise<void>;
export declare function renamePairedNode(nodeId: string, displayName: string, baseDir?: string): Promise<NodePairingPairedNode | null>;
export {};
