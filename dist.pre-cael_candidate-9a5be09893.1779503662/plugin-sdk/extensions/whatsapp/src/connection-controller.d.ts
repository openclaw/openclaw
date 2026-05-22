import { type WASocket } from "baileys";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { ActiveWebListener, WebListenerCloseReason } from "./inbound/types.js";
import { type ReconnectPolicy } from "./reconnect.js";
import { createWaSocket, waitForWaConnection } from "./session.js";
import type { WhatsAppSocketTimingOptions } from "./socket-timing.js";
export declare const WHATSAPP_LOGGED_OUT_QR_MESSAGE = "WhatsApp reported the session is logged out. Cleared cached web session; please scan a new QR.";
export declare const WHATSAPP_WATCHDOG_TIMEOUT_ERROR = "watchdog-timeout";
type TimerHandle = ReturnType<typeof setInterval>;
type WaSocket = Awaited<ReturnType<typeof createWaSocket>>;
export type ManagedWhatsAppListener = ActiveWebListener & {
    close?: () => Promise<void>;
    onClose?: Promise<WebListenerCloseReason>;
    signalClose?: (reason?: WebListenerCloseReason) => void;
};
type WhatsAppLiveConnection = {
    connectionId: string;
    startedAt: number;
    sock: WASocket;
    listener: ManagedWhatsAppListener;
    heartbeat: TimerHandle | null;
    watchdogTimer: TimerHandle | null;
    lastInboundAt: number | null;
    lastTransportActivityAt: number;
    handledMessages: number;
    unregisterUnhandled: (() => void) | null;
    unregisterTransportActivity: (() => void) | null;
    openedAfterRecentInbound: boolean;
    backgroundTasks: Set<Promise<unknown>>;
    closePromise: Promise<WebListenerCloseReason>;
    resolveClose: (reason: WebListenerCloseReason) => void;
};
type WhatsAppConnectionSnapshot = {
    connectionId: string;
    startedAt: number;
    lastInboundAt: number | null;
    lastTransportActivityAt: number;
    handledMessages: number;
    reconnectAttempts: number;
    uptimeMs: number;
};
type NormalizedConnectionCloseReason = {
    statusCode?: number;
    statusLabel: number | "unknown";
    isLoggedOut: boolean;
    error?: unknown;
    errorText: string;
};
type WhatsAppConnectionCloseDecision = {
    action: "stop" | "retry";
    delayMs?: number;
    reconnectAttempts: number;
    healthState: "logged-out" | "conflict" | "stopped" | "reconnecting";
    normalized: NormalizedConnectionCloseReason;
};
type WhatsAppReconnectAttemptDecision = {
    action: "stop" | "retry";
    delayMs?: number;
    reconnectAttempts: number;
    healthState: "stopped" | "reconnecting";
};
export declare function closeWaSocket(sock: {
    end?: (error: Error | undefined) => void;
    ws?: {
        close?: () => void;
    };
} | null | undefined): void;
export declare function closeWaSocketSoon(sock: {
    end?: (error: Error | undefined) => void;
    ws?: {
        close?: () => void;
    };
} | null | undefined, delayMs?: number): void;
type WhatsAppLoginWaitResult = {
    outcome: "connected";
    restarted: boolean;
    sock: WaSocket;
} | {
    outcome: "logged-out";
    message: string;
    statusCode: number;
    error: unknown;
} | {
    outcome: "failed";
    message: string;
    statusCode?: number;
    error: unknown;
};
export declare function waitForWhatsAppLoginResult(params: {
    sock: WaSocket;
    authDir: string;
    isLegacyAuthDir: boolean;
    verbose: boolean;
    runtime: RuntimeEnv;
    waitForConnection?: typeof waitForWaConnection;
    createSocket?: typeof createWaSocket;
    socketTiming?: WhatsAppSocketTimingOptions;
    onQr?: (qr: string) => void;
    onSocketReplaced?: (sock: WaSocket) => void;
}): Promise<WhatsAppLoginWaitResult>;
export declare class WhatsAppConnectionController {
    readonly accountId: string;
    readonly authDir: string;
    readonly socketRef: {
        current: WASocket | null;
    };
    private readonly reconnectPolicy;
    private readonly heartbeatSeconds;
    private readonly keepAlive;
    private readonly transportTimeoutMs;
    private readonly messageTimeoutMs;
    private readonly appSilenceTimeoutMs;
    private readonly watchdogCheckMs;
    private readonly verbose;
    private readonly abortSignal?;
    private readonly sleep;
    private readonly isNonRetryableStatus;
    private readonly socketTiming;
    private readonly abortPromise?;
    private readonly disconnectRetryController;
    private current;
    private reconnectAttempts;
    private lastHandledInboundAt;
    constructor(params: {
        accountId: string;
        authDir: string;
        verbose: boolean;
        keepAlive: boolean;
        heartbeatSeconds: number;
        transportTimeoutMs: number;
        messageTimeoutMs: number;
        watchdogCheckMs: number;
        reconnectPolicy: ReconnectPolicy;
        abortSignal?: AbortSignal;
        sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
        isNonRetryableStatus?: (statusCode: unknown) => boolean;
        socketTiming?: WhatsAppSocketTimingOptions;
    });
    getActiveListener(): ActiveWebListener | null;
    getReconnectAttempts(): number;
    isStopRequested(): boolean;
    shouldRetryDisconnect(): boolean;
    getDisconnectRetryAbortSignal(): AbortSignal;
    noteInbound(timestamp?: number): void;
    noteTransportActivity(timestamp?: number): void;
    getCurrentSnapshot(connection?: WhatsAppLiveConnection | null): WhatsAppConnectionSnapshot | null;
    setUnhandledRejectionCleanup(unregister: (() => void) | null): void;
    openConnection(params: {
        connectionId: string;
        createListener: (context: {
            sock: WASocket;
            connection: WhatsAppLiveConnection;
        }) => Promise<ManagedWhatsAppListener>;
        onHeartbeat?: (snapshot: WhatsAppConnectionSnapshot) => void;
        onWatchdogTimeout?: (snapshot: WhatsAppConnectionSnapshot) => void;
    }): Promise<WhatsAppLiveConnection>;
    waitForClose(): Promise<WebListenerCloseReason | "aborted">;
    normalizeCloseReason(reason: WebListenerCloseReason): NormalizedConnectionCloseReason;
    resolveCloseDecision(reason: WebListenerCloseReason | "aborted"): WhatsAppConnectionCloseDecision | "aborted";
    consumeReconnectAttempt(): WhatsAppReconnectAttemptDecision;
    forceClose(reason: WebListenerCloseReason): void;
    closeCurrentConnection(): Promise<void>;
    waitBeforeRetry(delayMs: number): Promise<void>;
    shutdown(): Promise<void>;
    private startTimers;
    private attachTransportActivityListener;
    private isOpeningAfterRecentInbound;
    private stopDisconnectRetries;
}
export {};
