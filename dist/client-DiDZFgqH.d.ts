import { n as GatewayClientName, t as GatewayClientMode } from "./client-info-Bg3dBQ8F.js";
import { dt as EventFrame, yt as HelloOk } from "./types-DOsLYgS6.js";

//#region src/infra/device-identity.d.ts
type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};
//#endregion
//#region src/gateway/client.d.ts
type GatewayClientRequestOptions = {
  expectFinal?: boolean;
  timeoutMs?: number | null;
  signal?: AbortSignal; /** Called once for expectFinal requests after an accepted response, before the final result. */
  onAccepted?: (payload: unknown) => void;
};
type GatewayReconnectPausedInfo = {
  code: number;
  reason: string;
  detailCode: string | null;
};
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
declare class GatewayClient {
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
export { DeviceIdentity as a, GatewayReconnectPausedInfo as i, GatewayClientOptions as n, GatewayClientRequestOptions as r, GatewayClient as t };