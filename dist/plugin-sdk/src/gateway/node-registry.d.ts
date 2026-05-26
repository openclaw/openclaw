import type { GatewayWsClient } from "./server/ws-types.js";
export type NodeSession = {
    nodeId: string;
    connId: string;
    client: GatewayWsClient;
    clientId?: string;
    clientMode?: string;
    displayName?: string;
    platform?: string;
    version?: string;
    coreVersion?: string;
    uiVersion?: string;
    deviceFamily?: string;
    modelIdentifier?: string;
    remoteIp?: string;
    declaredCaps: string[];
    caps: string[];
    declaredCommands: string[];
    commands: string[];
    declaredPermissions?: Record<string, boolean>;
    permissions?: Record<string, boolean>;
    pathEnv?: string;
    connectedAtMs: number;
};
type NodeInvokeResult = {
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: {
        code?: string;
        message?: string;
    } | null;
};
type NodeConnectivityResult = {
    ok: true;
} | {
    ok: false;
    error: {
        code: string;
        message: string;
    };
};
declare const SERIALIZED_EVENT_PAYLOAD: unique symbol;
export type SerializedEventPayload = {
    readonly json: string;
    readonly [SERIALIZED_EVENT_PAYLOAD]: true;
};
export declare function serializeEventPayload(payload: unknown): SerializedEventPayload | null;
export declare class NodeRegistry {
    private nodesById;
    private nodesByConn;
    private pendingInvokes;
    private authorizedSystemRunEvents;
    register(client: GatewayWsClient, opts: {
        remoteIp?: string | undefined;
    }): NodeSession;
    unregister(connId: string): string | null;
    listConnected(): NodeSession[];
    get(nodeId: string): NodeSession | undefined;
    checkConnectivity(nodeId: string, timeoutMs?: number): Promise<NodeConnectivityResult>;
    updateCommands(nodeId: string, commands: readonly string[]): NodeSession | null;
    updateSurface(nodeId: string, surface: {
        caps?: readonly string[];
        commands: readonly string[];
        permissions?: Record<string, boolean> | undefined;
    }): NodeSession | null;
    invoke(params: {
        nodeId: string;
        command: string;
        params?: unknown;
        timeoutMs?: number;
        idempotencyKey?: string;
    }): Promise<NodeInvokeResult>;
    authorizeSystemRunEvent(params: {
        nodeId: string;
        connId?: string;
        runId?: string;
        sessionKey: string;
        terminal: boolean;
    }): boolean;
    private rememberAuthorizedSystemRunEvent;
    private forgetAuthorizedSystemRunEvent;
    private authorizedSystemRunEventExpiresAt;
    private matchAuthorizedSystemRunEvent;
    private matchSingleAuthorizedSystemRunEvent;
    private authorizedSystemRunSessionMatches;
    private allowsLegacyMacRunIdFallback;
    private pruneAuthorizedSystemRunEvents;
    private authorizedSystemRunEventKey;
    handleInvokeResult(params: {
        id: string;
        nodeId: string;
        connId: string | undefined;
        ok: boolean;
        payload?: unknown;
        payloadJSON?: string | null;
        error?: {
            code?: string;
            message?: string;
        } | null;
    }): boolean;
    sendEvent(nodeId: string, event: string, payload?: unknown): boolean;
    sendEventRaw(nodeId: string, event: string, payloadJSON?: SerializedEventPayload | null): boolean;
    private sendEventInternal;
    private sendEventRawInternal;
    private sendEventToSession;
    private rejectSlowNodeSocket;
}
export {};
