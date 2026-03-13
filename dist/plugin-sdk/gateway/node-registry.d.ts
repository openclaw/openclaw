import type { GatewayWsClient } from "./server/ws-types.js";
export type NodeSession = {
    nodeId: string;
    connId: string;
    client: GatewayWsClient;
    displayName?: string;
    platform?: string;
    version?: string;
    coreVersion?: string;
    uiVersion?: string;
    deviceFamily?: string;
    modelIdentifier?: string;
    remoteIp?: string;
    caps: string[];
    commands: string[];
    permissions?: Record<string, boolean>;
    pathEnv?: string;
    connectedAtMs: number;
};
export type NodeInvokeResult = {
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: {
        code?: string;
        message?: string;
    } | null;
};
export declare class NodeRegistry {
    private nodesById;
    private nodesByConn;
    private pendingInvokes;
    register(client: GatewayWsClient, opts: {
        remoteIp?: string | undefined;
    }): NodeSession;
    unregister(connId: string): string | null;
    listConnected(): NodeSession[];
    get(nodeId: string): NodeSession | undefined;
    invoke(params: {
        nodeId: string;
        command: string;
        params?: unknown;
        timeoutMs?: number;
        idempotencyKey?: string;
    }): Promise<NodeInvokeResult>;
    handleInvokeResult(params: {
        id: string;
        nodeId: string;
        ok: boolean;
        payload?: unknown;
        payloadJSON?: string | null;
        error?: {
            code?: string;
            message?: string;
        } | null;
    }): boolean;
    sendEvent(nodeId: string, event: string, payload?: unknown): boolean;
    private sendEventInternal;
    private sendEventToSession;
}
