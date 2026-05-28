import { a as DeviceAuthTokenRecord, c as GatewayClient, d as GatewayClientRequestError, f as GatewayClientRequestOptions, g as resolveGatewayClientConnectChallengeTimeoutMs, h as isGatewayConnectAssemblyError, i as waitForEventLoopReady, l as GatewayClientHostDeps, m as describeGatewayCloseCode, n as startGatewayClientWhenEventLoopReady, o as DeviceIdentity, p as GatewayReconnectPausedInfo, r as EventLoopReadyResult, s as GATEWAY_CLOSE_CODE_HINTS, t as GatewayClientStartReadinessOptions, u as GatewayClientOptions } from "./readiness-D3ZeZIsg.mjs";
import { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS, MAX_CONNECT_CHALLENGE_TIMEOUT_MS, MIN_CONNECT_CHALLENGE_TIMEOUT_MS, clampConnectChallengeTimeoutMs, getConnectChallengeTimeoutMsFromEnv, getPreauthHandshakeTimeoutMsFromEnv, resolveConnectChallengeTimeoutMs, resolvePreauthHandshakeTimeoutMs } from "./timeouts.mjs";

//#region packages/gateway-client/src/device-auth.d.ts
declare function normalizeDeviceMetadataForAuth(value?: string | null): string;
type DeviceAuthPayloadParams = {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
};
type DeviceAuthPayloadV3Params = DeviceAuthPayloadParams & {
  platform?: string | null;
  deviceFamily?: string | null;
};
declare function buildDeviceAuthPayload(params: DeviceAuthPayloadParams): string;
declare function buildDeviceAuthPayloadV3(params: DeviceAuthPayloadV3Params): string;
//#endregion
export { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS, DeviceAuthTokenRecord, DeviceIdentity, EventLoopReadyResult, GATEWAY_CLOSE_CODE_HINTS, GatewayClient, GatewayClientHostDeps, GatewayClientOptions, GatewayClientRequestError, GatewayClientRequestOptions, GatewayClientStartReadinessOptions, GatewayReconnectPausedInfo, MAX_CONNECT_CHALLENGE_TIMEOUT_MS, MIN_CONNECT_CHALLENGE_TIMEOUT_MS, buildDeviceAuthPayload, buildDeviceAuthPayloadV3, clampConnectChallengeTimeoutMs, describeGatewayCloseCode, getConnectChallengeTimeoutMsFromEnv, getPreauthHandshakeTimeoutMsFromEnv, isGatewayConnectAssemblyError, normalizeDeviceMetadataForAuth, resolveConnectChallengeTimeoutMs, resolveGatewayClientConnectChallengeTimeoutMs, resolvePreauthHandshakeTimeoutMs, startGatewayClientWhenEventLoopReady, waitForEventLoopReady };