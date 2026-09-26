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

/**
 * The share of a stop deadline the exit margin may take when the deadline is too
 * short to fund it outright.
 *
 * `GATEWAY_SUPERVISOR_EXIT_MARGIN_MS` was sized against the 315 second policy drain,
 * where it is rounding error. A launchd job may enforce any `ExitTimeOut`, and
 * subtracting a fixed 5 seconds from a 5 second deadline consumes it whole, leaving a
 * shutdown budget of zero: the Gateway force-exits before draining anything. Capping
 * the margin at a share of the deadline keeps the full 5 seconds once the deadline can
 * afford it, from 20 seconds up, and otherwise leaves a positive budget behind.
 */
const GATEWAY_SUPERVISOR_EXIT_MARGIN_SHARE = 0.25;

/**
 * The drain a shutdown budget keeps for active work before the reserve claims any of it.
 *
 * 5 seconds is the drain the shipped LaunchAgent template already yields: its 20 second
 * `ExitTimeOut` funds the 5 second margin and the 10 second reserve outright and leaves
 * active work the remaining 5. Holding that as a floor keeps the reserve whole, the full
 * 10 seconds, for every stop budget of 15 seconds or more, and 15000 is exactly the
 * smallest budget that does. An `ExitTimeOut` of 20 seconds clears that bar only when
 * the probe that reads it costs nothing; every real cost comes off the reserve first.
 * That probe is up to three `launchctl print` calls at `LAUNCHCTL_PRINT_TIMEOUT_MS`
 * (2 seconds) each, so its cost is bounded near 6 seconds, not the low milliseconds one
 * measured host might suggest. Which allowance pays that cost turns on a 5 second
 * threshold. At or under 5
 * seconds of probe cost the reserve absorbs all of it and this floor is untouched, so a
 * 20 second deadline resolves `10000 - cost` of reserve against a flat 5 second drain and
 * gives up exactly what the probe cost (13ms measured here, so 9987). Over 5 seconds the
 * share below bounds the floor too and the two converge on half the remainder: a 6 second
 * cost leaves a 9 second budget that splits 4500/4500, which does NOT retain the old
 * reserve, and reaching it needs all three domain probes to hit their full timeout.
 * Below 20 seconds of deadline, the reserve this yields is already below what a flat
 * subtraction left, from roughly 8 seconds up to 20 seconds of deadline: that includes
 * 16 to 19 seconds, where a flat subtraction still funded the reserve in full and left
 * a positive drain of its own (1 to 4 seconds). At 15 seconds the reserve now gives up
 * 3750 of its 10000 to fund the drain floor, and at 10 seconds, where a flat subtraction
 * had already cut the reserve to 5000, it gives up another 1250. The share bounds the
 * shortest case: a budget under 10 seconds splits evenly rather than handing drain
 * everything.
 */
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

/**
 * The stop deadline the containing service imposes on a respawning launcher.
 *
 * A launchd job running OpenClaw's own label is bounded by the LaunchAgent
 * template's `ExitTimeOut`; anything else falls back to the platform-neutral stop
 * policy. The launcher reads this from its own environment, and a respawned child
 * inherits that environment unchanged, so both answer identically.
 */
const resolveRespawnServiceStopTimeoutMs = (env, platform) => {
  const launchdService = env.OPENCLAW_LAUNCHD_LABEL?.trim();
  return platform === "darwin" && launchdService && env.XPC_SERVICE_NAME === launchdService
    ? LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS * 1_000
    : GATEWAY_SERVICE_STOP_TIMEOUT_MS;
};

/**
 * Markers a `runRespawnedChild` parent stamps on the Gateway it respawned.
 *
 * Every call site of that function sets exactly one of these, so any one of them
 * establishes that this process's parent reached `runRespawnedChild` and is counting
 * down the escalation `resolveLauncherStopTimeoutMs` describes. Checking only the
 * Node-recovery marker would miss the two compile-cache respawns, which reach the
 * same launcher through the same function and would otherwise let a job deadline be
 * budgeted past the force-kill their parent has already armed.
 *
 * The compile-cache marker is not exclusive to that launcher: `entry.compile-cache.ts`
 * sets the same name for its own respawner, which reaps on a fixed short grace instead.
 * That respawner refuses a foreground Gateway run outright on every platform but
 * Windows, and this deadline is only ever read during a darwin stop, so it cannot be
 * the parent of a process that reaches here. Treat the overlap as load bearing if that
 * refusal is ever relaxed.
 *
 * They are listed here rather than in `src` deliberately: the names predate this
 * derivation, and repeating the literals inside the env-count ratchet's scope would
 * raise a budget that this change otherwise leaves untouched.
 */
const RESPAWN_LAUNCHER_MARKER_ENV_VARS = [
  "OPENCLAW_NODE_UPDATE_RESPAWNED",
  "OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED",
  "OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED",
];

/** Whether a `runRespawnedChild` parent started this process. */
export const isRespawnedByLauncher = (env) =>
  RESPAWN_LAUNCHER_MARKER_ENV_VARS.some((name) => env[name] === "1");

/**
 * The deadline the Node recovery launcher enforces on the Gateway it respawned.
 *
 * The launcher forwards the stop signal, waits out the exit grace, then force-kills
 * one force-kill grace later, so that sum is the deadline the child actually gets.
 * `foreground` mirrors the launcher's own argv test, and a respawned child carries
 * the same user arguments, so the child reproduces the launcher's answer from its
 * own argv without the launcher having to declare it.
 */
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
