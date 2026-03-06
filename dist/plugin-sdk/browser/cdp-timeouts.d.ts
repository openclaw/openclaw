export declare const CDP_HTTP_REQUEST_TIMEOUT_MS = 1500;
export declare const CDP_WS_HANDSHAKE_TIMEOUT_MS = 5000;
export declare const CDP_JSON_NEW_TIMEOUT_MS = 1500;
export declare const CHROME_REACHABILITY_TIMEOUT_MS = 500;
export declare const CHROME_WS_READY_TIMEOUT_MS = 800;
export declare const CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS = 10000;
export declare const CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS = 5000;
export declare const CHROME_LAUNCH_READY_WINDOW_MS = 15000;
export declare const CHROME_LAUNCH_READY_POLL_MS = 200;
export declare const CHROME_STOP_TIMEOUT_MS = 2500;
export declare const CHROME_STOP_PROBE_TIMEOUT_MS = 200;
export declare const CHROME_STDERR_HINT_MAX_CHARS = 2000;
export declare const PROFILE_HTTP_REACHABILITY_TIMEOUT_MS = 300;
export declare const PROFILE_WS_REACHABILITY_MIN_TIMEOUT_MS = 200;
export declare const PROFILE_WS_REACHABILITY_MAX_TIMEOUT_MS = 2000;
export declare const PROFILE_ATTACH_RETRY_TIMEOUT_MS = 1200;
export declare const PROFILE_POST_RESTART_WS_TIMEOUT_MS = 600;
export declare function resolveCdpReachabilityTimeouts(params: {
    profileIsLoopback: boolean;
    timeoutMs?: number;
    remoteHttpTimeoutMs: number;
    remoteHandshakeTimeoutMs: number;
}): {
    httpTimeoutMs: number;
    wsTimeoutMs: number;
};
