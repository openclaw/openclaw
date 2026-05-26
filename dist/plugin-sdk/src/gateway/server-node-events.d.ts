import type { NodeEvent, NodeEventContext } from "./server-node-events-types.js";
export type NodeEventHandleResult = {
    ok: true;
    event: string;
    handled: boolean;
    reason?: string;
};
export declare function resetNodeEventDeduplicationForTests(): void;
export declare function getRecentNodePresencePersistCountForTests(): number;
export declare const handleNodeEvent: (ctx: NodeEventContext, nodeId: string, evt: NodeEvent, opts?: {
    connId?: string;
    deviceId?: string;
}) => Promise<NodeEventHandleResult | undefined>;
