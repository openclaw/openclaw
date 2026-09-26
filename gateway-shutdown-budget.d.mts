export const GATEWAY_SHUTDOWN_RESERVE_MS: number;
export const GATEWAY_SUPERVISOR_EXIT_MARGIN_MS: number;
export const GATEWAY_SHUTDOWN_TIMEOUT_MS: number;
export const GATEWAY_SERVICE_STOP_TIMEOUT_MS: number;
export const LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS: 20;
export const GATEWAY_RESTART_REPLACEMENT_TIMEOUT_MS: number;
export const RESPAWN_SIGNAL_FORCE_KILL_GRACE_MS: number;
export const RESPAWN_SIGNAL_HARD_EXIT_GRACE_MS: number;
export function resolveSupervisorExitMarginMs(stopTimeoutMs: number): number;
export function resolveShutdownReserveMs(shutdownTimeoutMs: number): number;
export function isRespawnedByLauncher(env: NodeJS.ProcessEnv): boolean;
export function resolveLauncherStopTimeoutMs(params: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  foreground: boolean;
}): number;
