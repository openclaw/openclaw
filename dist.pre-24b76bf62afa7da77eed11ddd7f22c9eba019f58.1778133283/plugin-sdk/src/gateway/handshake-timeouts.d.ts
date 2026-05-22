export declare const DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS = 15000;
export declare const MIN_CONNECT_CHALLENGE_TIMEOUT_MS = 250;
export declare const MAX_CONNECT_CHALLENGE_TIMEOUT_MS = 15000;
export declare function clampConnectChallengeTimeoutMs(timeoutMs: number, maxTimeoutMs?: number): number;
export declare function getConnectChallengeTimeoutMsFromEnv(env?: NodeJS.ProcessEnv): number | undefined;
export declare function resolveConnectChallengeTimeoutMs(timeoutMs?: number | null, params?: {
    env?: NodeJS.ProcessEnv;
    configuredTimeoutMs?: number | null;
}): number;
export declare function getPreauthHandshakeTimeoutMsFromEnv(env?: NodeJS.ProcessEnv): number;
export declare function resolvePreauthHandshakeTimeoutMs(params?: {
    env?: NodeJS.ProcessEnv;
    configuredTimeoutMs?: number | null;
}): number;
