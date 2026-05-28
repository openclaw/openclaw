//#region packages/gateway-client/src/timeouts.d.ts
declare const DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 15000;
declare const MIN_CONNECT_CHALLENGE_TIMEOUT_MS = 250;
declare const MAX_CONNECT_CHALLENGE_TIMEOUT_MS = 15000;
declare function clampConnectChallengeTimeoutMs(timeoutMs: number, maxTimeoutMs?: number): number;
declare function getConnectChallengeTimeoutMsFromEnv(env?: NodeJS.ProcessEnv): number | undefined;
declare function resolveConnectChallengeTimeoutMs(timeoutMs?: number | null, params?: {
  env?: NodeJS.ProcessEnv;
  configuredTimeoutMs?: number | null;
}): number;
declare function getPreauthHandshakeTimeoutMsFromEnv(env?: NodeJS.ProcessEnv): number;
declare function resolvePreauthHandshakeTimeoutMs(params?: {
  env?: NodeJS.ProcessEnv;
  configuredTimeoutMs?: number | null;
}): number;
//#endregion
export { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS, MAX_CONNECT_CHALLENGE_TIMEOUT_MS, MIN_CONNECT_CHALLENGE_TIMEOUT_MS, clampConnectChallengeTimeoutMs, getConnectChallengeTimeoutMsFromEnv, getPreauthHandshakeTimeoutMsFromEnv, resolveConnectChallengeTimeoutMs, resolvePreauthHandshakeTimeoutMs };