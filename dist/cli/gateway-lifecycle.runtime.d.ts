import { s as getRuntimeConfig } from "../io-BSzQQn6M.js";
import { i as TaskRecord, l as TaskStatus } from "../task-registry.types-DRoZ8RRA.js";
import { i as waitForActiveEmbeddedRuns, o as getActiveEmbeddedRunCount, t as abortEmbeddedPiRun } from "../runs-B3uAznCF.js";
import { i as waitForActiveTasks, n as markGatewayDraining, r as resetAllLanes, t as getActiveTaskCount } from "../command-queue-Y7I5g9NL.js";
import { ChildProcess } from "node:child_process";

//#region src/infra/process-respawn.d.ts
type RespawnMode = "spawned" | "supervised" | "disabled" | "failed";
type GatewayRespawnResult = {
  mode: RespawnMode;
  pid?: number;
  detail?: string;
};
type GatewayUpdateRespawnResult = GatewayRespawnResult & {
  child?: ChildProcess;
};
/**
 * Attempt to restart this process with a fresh PID.
 * - supervised environments (launchd/systemd/schtasks): caller should exit and let supervisor restart
 * - OPENCLAW_NO_RESPAWN=1: caller should keep in-process restart behavior (tests/dev)
 * - otherwise: spawn detached child with current argv/execArgv, then caller exits
 */
declare function restartGatewayProcessWithFreshPid(): GatewayRespawnResult;
/**
 * Update restarts must replace the OS process so the new code runs from a
 * fresh module graph after package files have changed on disk.
 *
 * Unlike the generic restart path, update mode allows detached respawn on
 * unmanaged Windows installs because there is no safe in-process fallback once
 * the installed package contents have been replaced.
 */
declare function respawnGatewayProcessForUpdate(): GatewayUpdateRespawnResult;
//#endregion
//#region src/infra/restart.d.ts
declare function resetGatewayRestartStateForInProcessRestart(): void;
type RestartAuditInfo = {
  actor?: string;
  deviceId?: string;
  clientIp?: string;
  changedPaths?: string[];
};
type GatewayRestartIntent = {
  force?: boolean;
  waitMs?: number;
};
declare function consumeGatewayRestartIntentPayloadSync(env?: NodeJS.ProcessEnv, now?: number): GatewayRestartIntent | null;
declare function consumeGatewayRestartIntentSync(env?: NodeJS.ProcessEnv, now?: number): boolean;
declare function isGatewaySigusr1RestartExternallyAllowed(): boolean;
declare function consumeGatewaySigusr1RestartAuthorization(): boolean;
declare function peekGatewaySigusr1RestartReason(): string | undefined;
/**
 * Mark the currently emitted SIGUSR1 restart cycle as consumed by the run loop.
 * This explicitly advances the cycle state instead of resetting emit guards inside
 * consumeGatewaySigusr1RestartAuthorization().
 */
declare function markGatewaySigusr1RestartHandled(): void;
type RestartEmitHooks = {
  beforeEmit?: () => Promise<void>;
  afterEmitRejected?: () => Promise<void>;
};
declare function resolveGatewayRestartDeferralTimeoutMs(timeoutMs: unknown): number | undefined;
type ScheduledRestart = {
  ok: boolean;
  pid: number;
  signal: "SIGUSR1";
  delayMs: number;
  reason?: string;
  mode: "emit" | "signal" | "supervisor";
  coalesced: boolean;
  cooldownMsApplied: number;
};
declare function scheduleGatewaySigusr1Restart(opts?: {
  delayMs?: number;
  reason?: string;
  audit?: RestartAuditInfo;
  emitHooks?: RestartEmitHooks;
  skipDeferral?: boolean;
  skipCooldown?: boolean;
}): ScheduledRestart;
//#endregion
//#region src/infra/restart-handoff.d.ts
declare const GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND = "gateway-supervisor-restart-handoff";
type GatewayRestartHandoffRestartKind = "full-process" | "update-process";
type GatewayRestartHandoffSource = "config-write" | "gateway-update" | "operator-restart" | "plugin-change" | "signal" | "unknown";
type GatewayRestartHandoffSupervisorMode = "launchd" | "systemd" | "schtasks" | "external";
type GatewayRestartHandoff = {
  kind: typeof GATEWAY_SUPERVISOR_RESTART_HANDOFF_KIND;
  version: 1;
  intentId: string;
  pid: number;
  processInstanceId?: string;
  createdAt: number;
  expiresAt: number;
  reason?: string;
  source: GatewayRestartHandoffSource;
  restartKind: GatewayRestartHandoffRestartKind;
  supervisorMode: GatewayRestartHandoffSupervisorMode;
};
declare function writeGatewayRestartHandoffSync(opts: {
  env?: NodeJS.ProcessEnv;
  pid?: number;
  processInstanceId?: string;
  reason?: string;
  source?: GatewayRestartHandoffSource;
  restartKind: GatewayRestartHandoffRestartKind;
  supervisorMode?: GatewayRestartHandoffSupervisorMode | null;
  ttlMs?: number;
  createdAt?: number;
}): GatewayRestartHandoff | null;
//#endregion
//#region src/infra/restart-sentinel.d.ts
type RestartSentinelLog = {
  stdoutTail?: string | null;
  stderrTail?: string | null;
  exitCode?: number | null;
};
type RestartSentinelStep = {
  name: string;
  command: string;
  cwd?: string | null;
  durationMs?: number | null;
  log?: RestartSentinelLog | null;
};
type RestartSentinelStats = {
  mode?: string;
  root?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  steps?: RestartSentinelStep[];
  reason?: string | null;
  durationMs?: number | null;
};
type RestartSentinelContinuation = {
  kind: "systemEvent";
  text: string;
} | {
  kind: "agentTurn";
  message: string;
};
type RestartSentinelPayload = {
  kind: "config-apply" | "config-auto-recovery" | "config-patch" | "update" | "restart";
  status: "ok" | "error" | "skipped";
  ts: number;
  sessionKey?: string; /** Delivery context captured at restart time to ensure channel routing survives restart. */
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
  }; /** Thread ID for reply threading (e.g., Slack thread_ts). */
  threadId?: string;
  message?: string | null;
  continuation?: RestartSentinelContinuation | null;
  doctorHint?: string | null;
  stats?: RestartSentinelStats | null;
};
type RestartSentinel = {
  version: 1;
  payload: RestartSentinelPayload;
};
declare function markUpdateRestartSentinelFailure(reason: string, env?: NodeJS.ProcessEnv): Promise<RestartSentinel | null>;
//#endregion
//#region src/infra/supervisor-markers.d.ts
type RespawnSupervisor = "launchd" | "systemd" | "schtasks";
declare function detectRespawnSupervisor(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): RespawnSupervisor | null;
//#endregion
//#region src/logging/diagnostic-stability-bundle.d.ts
type WriteDiagnosticStabilityBundleOptions = {
  reason: string;
  error?: unknown;
  includeEmpty?: boolean;
  limit?: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  retention?: number;
};
type DiagnosticStabilityBundleFailureWriteOutcome = {
  status: "written";
  message: string;
  path: string;
} | {
  status: "failed";
  message: string;
  error: unknown;
} | {
  status: "skipped";
  reason: "empty";
};
type WriteDiagnosticStabilityBundleForFailureOptions = Omit<WriteDiagnosticStabilityBundleOptions, "error" | "includeEmpty" | "reason">;
declare function writeDiagnosticStabilityBundleForFailureSync(reason: string, error?: unknown, options?: WriteDiagnosticStabilityBundleForFailureOptions): DiagnosticStabilityBundleFailureWriteOutcome;
//#endregion
//#region src/tasks/task-registry.d.ts
declare function reloadTaskRegistryFromStore(): void;
//#endregion
//#region src/tasks/task-registry.maintenance.d.ts
type ActiveTaskRestartBlocker = {
  taskId: string;
  status: Extract<TaskStatus, "running">;
  runtime: TaskRecord["runtime"];
  runId?: string;
  label?: string;
  title?: string;
};
declare function getInspectableActiveTaskRestartBlockers(): ActiveTaskRestartBlocker[];
//#endregion
export { abortEmbeddedPiRun, consumeGatewayRestartIntentPayloadSync, consumeGatewayRestartIntentSync, consumeGatewaySigusr1RestartAuthorization, detectRespawnSupervisor, getActiveEmbeddedRunCount, getActiveTaskCount, getInspectableActiveTaskRestartBlockers, getRuntimeConfig, isGatewaySigusr1RestartExternallyAllowed, markGatewayDraining, markGatewaySigusr1RestartHandled, markUpdateRestartSentinelFailure, peekGatewaySigusr1RestartReason, reloadTaskRegistryFromStore, resetAllLanes, resetGatewayRestartStateForInProcessRestart, resolveGatewayRestartDeferralTimeoutMs, respawnGatewayProcessForUpdate, restartGatewayProcessWithFreshPid, scheduleGatewaySigusr1Restart, waitForActiveEmbeddedRuns, waitForActiveTasks, writeDiagnosticStabilityBundleForFailureSync, writeGatewayRestartHandoffSync };