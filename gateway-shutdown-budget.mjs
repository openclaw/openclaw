// Shared stop policy; v2026.9.5 restart-health.constants.ts fixes the replacement window.
export const GATEWAY_RESTART_REPLACEMENT_TIMEOUT_MS = 60_000;
const GATEWAY_SHUTDOWN_DRAIN_TIMEOUT_MS = 315_000;
export const GATEWAY_SHUTDOWN_RESERVE_MS = 10_000;
export const GATEWAY_SUPERVISOR_EXIT_MARGIN_MS = 5_000;
export const GATEWAY_SHUTDOWN_TIMEOUT_MS =
  GATEWAY_SHUTDOWN_DRAIN_TIMEOUT_MS + GATEWAY_SHUTDOWN_RESERVE_MS;
export const GATEWAY_SERVICE_STOP_TIMEOUT_MS =
  GATEWAY_SHUTDOWN_TIMEOUT_MS + GATEWAY_SUPERVISOR_EXIT_MARGIN_MS;

export const LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS = 20;

// Keep a positive shutdown budget when a supervisor's deadline is under 20s.
const GATEWAY_SUPERVISOR_EXIT_MARGIN_SHARE = 0.25;

// Preserve the template's 5s drain where possible. Under 20s, trade some cleanup
// reserve for drain; on very short jobs, split the remaining budget in half.
// Inspection time is debited before this allocation, so a slow probe can also
// reduce the drain. The measured upgrade tradeoff is documented in restart-recovery.
const GATEWAY_SHUTDOWN_DRAIN_FLOOR_MS = 5_000;
const GATEWAY_SHUTDOWN_DRAIN_FLOOR_SHARE = 0.5;

/** The exit margin to hold back from a supervisor-enforced stop deadline. */
export const resolveSupervisorExitMarginMs = (stopTimeoutMs) =>
  Math.min(
    GATEWAY_SUPERVISOR_EXIT_MARGIN_MS,
    Math.floor(Math.max(0, stopTimeoutMs) * GATEWAY_SUPERVISOR_EXIT_MARGIN_SHARE),
  );

/** The post-drain reserve to hold back from a resolved shutdown budget. */
export const resolveShutdownReserveMs = (shutdownTimeoutMs) => {
  const budgetMs = Math.max(0, shutdownTimeoutMs);
  const drainFloorMs = Math.min(
    GATEWAY_SHUTDOWN_DRAIN_FLOOR_MS,
    Math.floor(budgetMs * GATEWAY_SHUTDOWN_DRAIN_FLOOR_SHARE),
  );
  return Math.min(GATEWAY_SHUTDOWN_RESERVE_MS, budgetMs - drainFloorMs);
};

// Escalation graces the Node recovery launcher applies to a stopping child. Kept
// here rather than in the launcher so the serving Gateway can derive the deadline
// its parent enforces from the same numbers the parent armed it from.
const RESPAWN_SIGNAL_EXIT_GRACE_MS = 1_000;
export const RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS = 1_000;
export const RESPAWN_SIGNAL_HARD_EXIT_GRACE_MS = 1_000;

// A launcher inside OpenClaw's LaunchAgent gets its template deadline; otherwise
// it uses the generic service stop policy. Its child inherits these markers.
const resolveRespawnServiceStopTimeoutMs = (env, platform) => {
  const launchdService = env.OPENCLAW_LAUNCHD_LABEL?.trim();
  return platform === "darwin" && launchdService && env.XPC_SERVICE_NAME === launchdService
    ? LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS * 1_000
    : GATEWAY_SERVICE_STOP_TIMEOUT_MS;
};

// Every runRespawnedChild call site stamps one of these. The compile-cache
// marker is also used by a different respawner, but that one refuses foreground
// Gateway runs on darwin. Keep this list with the launcher deadline it authorizes.
const RESPAWN_LAUNCHER_MARKER_ENV_VARS = [
  "OPENCLAW_NODE_UPDATE_RESPAWNED",
  "OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED",
  "OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED",
];

/** Whether a `runRespawnedChild` parent started this process. */
export const isRespawnedByLauncher = (env) =>
  RESPAWN_LAUNCHER_MARKER_ENV_VARS.some((name) => env[name] === "1");

// Shared with the serving Gateway: derive the parent's reap deadline from the
// same graces, including on the first update while the old launcher is still live.
export const resolveLauncherStopTimeoutMs = ({ env, platform, foreground }) => {
  const serviceStopTimeoutMs = resolveRespawnServiceStopTimeoutMs(env, platform);
  const signalExitGraceMs =
    platform !== "win32" && foreground
      ? serviceStopTimeoutMs -
        RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS -
        RESPAWN_SIGNAL_HARD_EXIT_GRACE_MS
      : RESPAWN_SIGNAL_EXIT_GRACE_MS;
  return signalExitGraceMs + RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS;
};
