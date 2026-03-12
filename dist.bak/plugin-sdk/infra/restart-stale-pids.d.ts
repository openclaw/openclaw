/**
 * Find PIDs of gateway processes listening on the given port using synchronous lsof.
 * Returns only PIDs that belong to openclaw gateway processes (not the current process).
 */
export declare function findGatewayPidsOnPortSync(port: number): number[];
/**
 * Inspect the gateway port and kill any stale gateway processes holding it.
 * Called before service restart commands to prevent port conflicts.
 */
export declare function cleanStaleGatewayProcessesSync(): number[];
export declare const __testing: {
    setSleepSyncOverride(fn: ((ms: number) => void) | null): void;
};
