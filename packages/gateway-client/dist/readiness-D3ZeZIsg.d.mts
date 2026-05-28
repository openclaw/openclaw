import { GatewayClientMode, GatewayClientName } from "@openclaw/gateway-protocol/client-info";
import { EventFrame, HelloOk } from "@openclaw/gateway-protocol";

//#region packages/gateway-client/src/client.d.ts
type DeviceIdentity = {
  deviceId: string;
  privateKeyPem: string;
  publicKeyPem: string;
};
type DeviceAuthTokenRecord = {
  token?: string;
  scopes?: string[];
};
type GatewayClientHostDeps = {
  loadOrCreateDeviceIdentity?: () => DeviceIdentity | undefined;
  signDevicePayload?: (privateKeyPem: string, payload: string) => string;
  publicKeyRawBase64UrlFromPem?: (publicKeyPem: string) => string;
  loadDeviceAuthToken?: (params: {
    deviceId: string;
    role: string;
    env?: NodeJS.ProcessEnv;
  }) => DeviceAuthTokenRecord | null;
  storeDeviceAuthToken?: (params: {
    deviceId: string;
    role: string;
    token: string;
    scopes: string[];
    env?: NodeJS.ProcessEnv;
  }) => void;
  clearDeviceAuthToken?: (params: {
    deviceId: string;
    role: string;
    env?: NodeJS.ProcessEnv;
  }) => void;
  beforeConnect?: () => void;
  registerGatewayLoopbackBypass?: (url: string) => (() => void) | undefined;
  logDebug?: (message: string) => void;
  logError?: (message: string) => void;
  redactForLog?: (message: string) => string;
  normalizeTlsFingerprint?: (fingerprint: string | undefined) => string;
};
type GatewayClientRequestOptions = {
  expectFinal?: boolean;
  timeoutMs?: number | null;
  signal?: AbortSignal; /** Called once for expectFinal requests after an accepted response, before the final result. */
  onAccepted?: (payload: unknown) => void;
};
type GatewayClientErrorShape = {
  code?: string;
  message?: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
};
type GatewayReconnectPausedInfo = {
  code: number;
  reason: string;
  detailCode: string | null;
};
declare class GatewayClientRequestError extends Error {
  readonly gatewayCode: string;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(error: GatewayClientErrorShape);
}
declare function isGatewayConnectAssemblyError(value: unknown): value is Error;
type GatewayClientOptions = {
  url?: string;
  connectChallengeTimeoutMs?: number; /** @deprecated Use connectChallengeTimeoutMs. */
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
  approvalRuntimeToken?: string;
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
  env?: NodeJS.ProcessEnv;
  deviceIdentity?: DeviceIdentity | null;
  hostDeps?: GatewayClientHostDeps;
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
declare const GATEWAY_CLOSE_CODE_HINTS: Readonly<Record<number, string>>;
declare function describeGatewayCloseCode(code: number): string | undefined;
declare function resolveGatewayClientConnectChallengeTimeoutMs(opts: Pick<GatewayClientOptions, "connectChallengeTimeoutMs" | "connectDelayMs" | "preauthHandshakeTimeoutMs">): number;
declare class GatewayClient {
  private ws;
  private opts;
  private deps;
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
  private approvalRuntimeTokenCompatibilityDisabled;
  private approvalRuntimeTokenRetryBudgetUsed;
  private pendingStartupReconnectDelayMs;
  private pendingConnectErrorDetailCode;
  private pendingConnectErrorDetails;
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
  private logDebug;
  private logError;
  private sendConnect;
  private assembleConnectParams;
  private buildDeviceConnectParams;
  private handleConnectFailure;
  private notifyConnectError;
  private resolveConnectScopes;
  private loadStoredDeviceAuth;
  private shouldPauseReconnectAfterAuthFailure;
  private shouldRetryWithStoredDeviceToken;
  private shouldRetryWithoutApprovalRuntimeToken;
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
  request<T = Record<string, unknown>>(method: string, params?: unknown, opts?: GatewayClientRequestOptions): Promise<T>;
}
//#endregion
//#region packages/gateway-client/src/event-loop-ready.d.ts
type EventLoopReadyResult = {
  ready: boolean;
  elapsedMs: number;
  maxDriftMs: number;
  checks: number;
  aborted: boolean;
};
type EventLoopReadyOptions = {
  maxWaitMs?: number;
  intervalMs?: number;
  driftThresholdMs?: number;
  consecutiveReadyChecks?: number;
  signal?: AbortSignal;
};
declare function waitForEventLoopReady(options?: EventLoopReadyOptions): Promise<EventLoopReadyResult>;
//#endregion
//#region packages/gateway-client/src/readiness.d.ts
type GatewayClientStartReadinessOptions = {
  timeoutMs?: number;
  clientOptions?: Pick<GatewayClientOptions, "connectChallengeTimeoutMs" | "connectDelayMs" | "preauthHandshakeTimeoutMs">;
  signal?: AbortSignal;
};
declare function startGatewayClientWhenEventLoopReady(client: GatewayClient, options?: GatewayClientStartReadinessOptions): Promise<EventLoopReadyResult>;
//#endregion
export { DeviceAuthTokenRecord as a, GatewayClient as c, GatewayClientRequestError as d, GatewayClientRequestOptions as f, resolveGatewayClientConnectChallengeTimeoutMs as g, isGatewayConnectAssemblyError as h, waitForEventLoopReady as i, GatewayClientHostDeps as l, describeGatewayCloseCode as m, startGatewayClientWhenEventLoopReady as n, DeviceIdentity as o, GatewayReconnectPausedInfo as p, EventLoopReadyResult as r, GATEWAY_CLOSE_CODE_HINTS as s, GatewayClientStartReadinessOptions as t, GatewayClientOptions as u };