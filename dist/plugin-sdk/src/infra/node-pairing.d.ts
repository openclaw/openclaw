import { type NodeApprovalScope } from "./node-pairing-authz.js";
type NodeDeclaredSurface = {
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
type NodeApprovedSurface = NodeDeclaredSurface;
export type NodePairingRequestInput = NodeDeclaredSurface & {
    silent?: boolean;
};
export type NodePairingPendingRequest = NodePairingRequestInput & {
    requestId: string;
    silent?: boolean;
    ts: number;
};
type NodePairingPendingEntry = NodePairingPendingRequest & {
    requiredApproveScopes: NodeApprovalScope[];
};
export type NodePairingPairedNode = NodeApprovedSurface & {
    token: string;
    bins?: string[];
    createdAtMs: number;
    approvedAtMs: number;
    lastConnectedAtMs?: number;
    lastSeenAtMs?: number;
    lastSeenReason?: string;
};
type NodePairingList = {
    pending: NodePairingPendingEntry[];
    paired: NodePairingPairedNode[];
};
type ApprovedNodePairingResult = {
    requestId: string;
    node: NodePairingPairedNode;
};
type ForbiddenNodePairingResult = {
    status: "forbidden";
    missingScope: string;
};
type ApproveNodePairingResult = ApprovedNodePairingResult | ForbiddenNodePairingResult | null;
export declare function listNodePairing(baseDir?: string): Promise<NodePairingList>;
export declare function getPairedNode(nodeId: string, baseDir?: string): Promise<NodePairingPairedNode | null>;
export declare function requestNodePairing(req: NodePairingRequestInput, baseDir?: string): Promise<{
    status: "pending";
    request: NodePairingPendingRequest;
    created: boolean;
}>;
export declare function approveNodePairing(requestId: string, options: {
    callerScopes?: readonly string[];
}, baseDir?: string): Promise<ApproveNodePairingResult>;
export declare function rejectNodePairing(requestId: string, baseDir?: string): Promise<{
    requestId: string;
    nodeId: string;
} | null>;
export declare function removePairedNode(nodeId: string, baseDir?: string): Promise<{
    nodeId: string;
} | null>;
export declare function verifyNodeToken(nodeId: string, token: string, baseDir?: string): Promise<{
    ok: boolean;
    node?: NodePairingPairedNode;
}>;
export declare function updatePairedNodeMetadata(nodeId: string, patch: Partial<Omit<NodePairingPairedNode, "nodeId" | "token" | "createdAtMs" | "approvedAtMs">>, baseDir?: string): Promise<boolean>;
export declare function renamePairedNode(nodeId: string, displayName: string, baseDir?: string): Promise<NodePairingPairedNode | null>;
export {};
