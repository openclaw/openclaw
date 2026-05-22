declare const NODE_PENDING_WORK_TYPES: readonly ["status.request", "location.request"];
export type NodePendingWorkType = (typeof NODE_PENDING_WORK_TYPES)[number];
declare const NODE_PENDING_WORK_PRIORITIES: readonly ["default", "normal", "high"];
export type NodePendingWorkPriority = (typeof NODE_PENDING_WORK_PRIORITIES)[number];
type NodePendingWorkItem = {
    id: string;
    type: NodePendingWorkType;
    priority: NodePendingWorkPriority;
    createdAtMs: number;
    expiresAtMs: number | null;
    payload?: Record<string, unknown>;
};
type DrainOptions = {
    maxItems?: number;
    includeDefaultStatus?: boolean;
    nowMs?: number;
};
type DrainResult = {
    revision: number;
    items: NodePendingWorkItem[];
    hasMore: boolean;
};
export declare function enqueueNodePendingWork(params: {
    nodeId: string;
    type: NodePendingWorkType;
    priority?: NodePendingWorkPriority;
    expiresInMs?: number;
    payload?: Record<string, unknown>;
}): {
    revision: number;
    item: NodePendingWorkItem;
    deduped: boolean;
};
export declare function drainNodePendingWork(nodeId: string, opts?: DrainOptions): DrainResult;
export declare function acknowledgeNodePendingWork(params: {
    nodeId: string;
    itemIds: string[];
}): {
    revision: number;
    removedItemIds: string[];
};
export declare function resetNodePendingWorkForTests(): void;
export declare function getNodePendingWorkStateCountForTests(): number;
export {};
