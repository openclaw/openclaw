import type { WebChannelHealthState, WebChannelStatus } from "./types.js";
export declare function createWebChannelStatusController(statusSink?: (status: WebChannelStatus) => void): {
    emit: () => void;
    snapshot: () => WebChannelStatus;
    noteConnected(at?: number): void;
    noteInbound(at?: number): void;
    noteTransportActivity(at?: number): void;
    noteWatchdogStale(at?: number): void;
    noteReconnectAttempts(reconnectAttempts: number): void;
    noteClose(params: {
        at?: number;
        statusCode?: number;
        loggedOut?: boolean;
        error?: string;
        reconnectAttempts: number;
        healthState: WebChannelHealthState;
        watchdogRecovery?: boolean;
    }): void;
    markStopped(at?: number): void;
};
