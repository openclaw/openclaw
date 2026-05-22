import type { DeviceIdentity } from "../infra/device-identity.js";
import { type GatewayClientMode, type GatewayClientName } from "../utils/message-channel.js";
import { type EventFrame, type HelloOk } from "./protocol/index.js";
type GatewayClientErrorShape = {
    code?: string;
    message?: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
};
export type GatewayReconnectPausedInfo = {
    code: number;
    reason: string;
    detailCode: string | null;
};
export declare class GatewayClientRequestError extends Error {
    readonly gatewayCode: string;
    readonly details?: unknown;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
    constructor(error: GatewayClientErrorShape);
}
export type GatewayClientOptions = {
    url?: string;
    connectChallengeTimeoutMs?: number;
    /** @deprecated Use connectChallengeTimeoutMs. */
    connectDelayMs?: number;
    /**
     * Server-side pre-auth handshake budget. Config-derived local clients use
     * this to keep the connect-challenge watchdog aligned with the gateway.
     */
    preauthHandshakeTimeoutMs?: number;
    tickWatchMinIntervalMs?: number;
    requestTimeoutMs?: number;
    token?: string;
    bootstrapToken?: string;
    deviceToken?: string;
    password?: string;
    instanceId?: string;
    clientName?: GatewayClientName;
    clientDisplayName?: string;
    clientVersion?: string;
    platform?: string;
    deviceFamily?: string;
    mode?: GatewayClientMode;
    role?: string;
    scopes?: string[];
    caps?: string[];
    commands?: string[];
    permissions?: Record<string, boolean>;
    pathEnv?: string;
    deviceIdentity?: DeviceIdentity | null;
    minProtocol?: number;
    maxProtocol?: number;
    tlsFingerprint?: string;
    onEvent?: (evt: EventFrame) => void;
    onHelloOk?: (hello: HelloOk) => void;
    onConnectError?: (err: Error) => void;
    onReconnectPaused?: (info: GatewayReconnectPausedInfo) => void;
    onClose?: (code: number, reason: string) => void;
    onGap?: (info: {
        expected: number;
        received: number;
    }) => void;
};
export declare const GATEWAY_CLOSE_CODE_HINTS: Readonly<Record<number, string>>;
export declare function describeGatewayCloseCode(code: number): string | undefined;
export declare function resolveGatewayClientConnectChallengeTimeoutMs(opts: Pick<GatewayClientOptions, "connectChallengeTimeoutMs" | "connectDelayMs" | "preauthHandshakeTimeoutMs">): number;
export declare class GatewayClient {
    private ws;
    private opts;
    private pending;
    private backoffMs;
    private closed;
    private lastSeq;
    private connectNonce;
    private connectSent;
    private connectTimer;
    private reconnectTimer;
    private pendingDeviceTokenRetry;
    private deviceTokenRetryBudgetUsed;
    private pendingStartupReconnectDelayMs;
    private pendingConnectErrorDetailCode;
    private lastTick;
    private tickIntervalMs;
    private tickTimer;
    private readonly requestTimeoutMs;
    private pendingStop;
    private socketOpened;
    constructor(opts: GatewayClientOptions);
    start(): void;
    stop(): void;
    stopAndWait(opts?: {
        timeoutMs?: number;
    }): Promise<void>;
    private beginStop;
    private createPendingStop;
    private resolvePendingStop;
    private sendConnect;
    private resolveConnectScopes;
    private loadStoredDeviceAuth;
    private shouldPauseReconnectAfterAuthFailure;
    private shouldRetryWithStoredDeviceToken;
    private isTrustedDeviceRetryEndpoint;
    private selectConnectAuth;
    private handleMessage;
    private beginPreauthHandshake;
    private clearConnectChallengeTimeout;
    private clearReconnectTimer;
    private armConnectChallengeTimeout;
    private scheduleReconnect;
    private flushPendingErrors;
    private startTickWatch;
    private validateTlsFingerprint;
    request<T = Record<string, unknown>>(method: string, params?: unknown, opts?: {
        expectFinal?: boolean;
        timeoutMs?: number | null;
    }): Promise<T>;
}
export {};
