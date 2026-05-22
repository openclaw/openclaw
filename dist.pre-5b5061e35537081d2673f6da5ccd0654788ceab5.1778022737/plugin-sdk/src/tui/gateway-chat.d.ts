import { type HelloOk, type SessionsListParams, type SessionsPatchResult, type SessionsPatchParams } from "../gateway/protocol/index.js";
import type { ChatSendOptions, TuiAgentsList, TuiBackend, TuiEvent, TuiModelChoice, TuiSessionList } from "./tui-backend.js";
export type GatewayConnectionOptions = {
    url?: string;
    token?: string;
    password?: string;
};
export type GatewayEvent = TuiEvent;
type ResolvedGatewayConnection = {
    url: string;
    token?: string;
    password?: string;
    preauthHandshakeTimeoutMs?: number;
    allowInsecureLocalOperatorUi?: boolean;
};
export type GatewaySessionList = TuiSessionList;
export type GatewayAgentsList = TuiAgentsList;
export type GatewayModelChoice = TuiModelChoice;
export declare class GatewayChatClient implements TuiBackend {
    private client;
    private readyPromise;
    private resolveReady?;
    readonly connection: ResolvedGatewayConnection;
    hello?: HelloOk;
    onEvent?: (evt: GatewayEvent) => void;
    onConnected?: () => void;
    onDisconnected?: (reason: string) => void;
    onGap?: (info: {
        expected: number;
        received: number;
    }) => void;
    constructor(connection: ResolvedGatewayConnection);
    static connect(opts: GatewayConnectionOptions): Promise<GatewayChatClient>;
    start(): void;
    stop(): void;
    waitForReady(): Promise<void>;
    sendChat(opts: ChatSendOptions): Promise<{
        runId: string;
    }>;
    abortChat(opts: {
        sessionKey: string;
        runId: string;
    }): Promise<{
        ok: boolean;
        aborted: boolean;
    }>;
    loadHistory(opts: {
        sessionKey: string;
        limit?: number;
    }): Promise<Record<string, unknown>>;
    listSessions(opts?: SessionsListParams): Promise<TuiSessionList>;
    listAgents(): Promise<TuiAgentsList>;
    patchSession(opts: SessionsPatchParams): Promise<SessionsPatchResult>;
    resetSession(key: string, reason?: "new" | "reset"): Promise<Record<string, unknown>>;
    getGatewayStatus(): Promise<Record<string, unknown>>;
    listModels(): Promise<GatewayModelChoice[]>;
}
export declare function resolveGatewayConnection(opts: GatewayConnectionOptions): Promise<ResolvedGatewayConnection>;
export {};
