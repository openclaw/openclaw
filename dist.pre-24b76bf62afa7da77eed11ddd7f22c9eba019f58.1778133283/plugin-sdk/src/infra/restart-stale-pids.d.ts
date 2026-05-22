declare function sleepSync(ms: number): void;
/**
 * Collect the set of PIDs whose termination would cascade-kill the caller:
 * the current process, its direct parent, and — where the platform permits
 * — the full ancestor chain up to the top of the pid namespace.
 *
 * Rationale: `cleanStaleGatewayProcessesSync` already refuses to kill
 * `process.pid` (see `parsePidsFromLsofOutput`), acknowledging the invariant
 * "a cleanup step must never destroy its own caller." That invariant was
 * applied only to the caller itself, not to its ancestors — which is how
 * issue #68451 arises: a plugin sidecar calls the cleanup, `lsof` reports
 * the parent gateway listening on 18789, the parent's PID passes the
 * `pid !== process.pid` filter, it is SIGTERM'd, the sidecar is then reaped
 * by the supervisor, the supervisor restarts the gateway, which re-spawns
 * the sidecar, which runs the cleanup again — infinite restart loop.
 *
 * Completing the invariant here removes the loop at its source: killing any
 * ancestor is exactly as fatal to the caller as killing itself, so ancestors
 * must receive the same exclusion treatment. The check admits any positive
 * ancestor PID (including 1), because inside a container — a first-class
 * deployment target for this project — the gateway is frequently the
 * entrypoint and therefore runs as PID 1 of its own namespace; excluding 1
 * unconditionally would recreate the #68451 loop on every containerised
 * install where the gateway spawns a direct-child sidecar.
 *
 * The walk is best-effort. `process.ppid` is provided by Node via a direct
 * syscall and is always available; transitive ancestors are only read on
 * Linux via `/proc`. macOS/Windows stop at ppid, which is sufficient for
 * the direct-child sidecar topology this bug describes; extending those
 * platforms can be done without touching the call sites.
 *
 * The function takes no parameters and exposes no hooks. Tests exercise
 * the real walk by stubbing `process.ppid` (and, on Linux, by mocking
 * `node:fs` to inject `/proc/<pid>/status` payloads) — there is no
 * reachable override for runtime callers to mutate.
 */
export declare function getSelfAndAncestorPidsSync(): Set<number>;
/**
 * Find PIDs of gateway processes listening on the given port using synchronous lsof.
 * Returns only PIDs that belong to openclaw gateway processes (not the current process).
 */
export declare function findGatewayPidsOnPortSync(port: number, spawnTimeoutMs?: number): number[];
/**
 * Inspect the gateway port and kill any stale gateway processes holding it.
 * Blocks until the port is confirmed free (or the poll budget expires) so
 * the supervisor (systemd / launchctl) does not race a zombie process for
 * the port and enter an EADDRINUSE restart loop.
 *
 * Called before service restart commands to prevent port conflicts.
 */
export declare function cleanStaleGatewayProcessesSync(portOverride?: number): number[];
export declare const __testing: {
    setSleepSyncOverride(fn: ((ms: number) => void) | null): void;
    setDateNowOverride(fn: (() => number) | null): void;
    setParentPidOverride(fn: (() => number) | null): void;
    /** Invoke sleepSync directly (bypasses the override) for unit-testing the real Atomics path. */
    callSleepSyncRaw: typeof sleepSync;
};
export {};
