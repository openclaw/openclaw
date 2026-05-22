import { i as OpenClawConfig } from "../types.openclaw-DBDmmaVM.js";
import { c as getRuntimeConfig } from "../io-2NJaRd0g.js";
import { S as DiagnosticMemoryPressureEvent, w as DiagnosticMemoryUsage } from "../diagnostic-events-DqBuU5-4.js";
import { i as TaskRecord, l as TaskStatus } from "../task-registry.types-DrU7zpIN.js";
import { a as waitForActiveEmbeddedRuns, c as listActiveEmbeddedRunSessionIds, l as listActiveEmbeddedRunSessionKeys, s as getActiveEmbeddedRunCount, t as abortEmbeddedPiRun } from "../runs-iFc8sSi8.js";
import { a as waitForActiveTasks, i as resetAllLanes, n as getActiveTaskCount, r as markGatewayDraining, t as markUpdateRestartSentinelFailure } from "../restart-sentinel-CAg-BqGL.js";
import { ChildProcess } from "node:child_process";

//#region src/agents/main-session-restart-recovery.d.ts
declare function markRestartAbortedMainSessions(params: {
  cfg?: OpenClawConfig;
  additionalCfgs?: Iterable<OpenClawConfig | undefined>;
  stateDir?: string;
  sessionKeys?: Iterable<string>;
  sessionIds?: Iterable<string>;
  reason?: string;
}): Promise<{
  marked: number;
  skipped: number;
}>;
//#endregion
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
type GatewayRespawnOptions = {
  env?: NodeJS.ProcessEnv;
};
/**
 * Attempt to restart this process with a fresh PID.
 * - supervised environments (launchd/systemd/schtasks): caller should exit and let supervisor restart
 * - OPENCLAW_NO_RESPAWN=1: caller should keep in-process restart behavior (tests/dev)
 * - otherwise: spawn detached child with current argv/execArgv, then caller exits
 */
declare function restartGatewayProcessWithFreshPid(opts?: GatewayRespawnOptions): GatewayRespawnResult;
/**
 * Update restarts must replace the OS process so the new code runs from a
 * fresh module graph after package files have changed on disk.
 *
 * Unlike the generic restart path, update mode allows detached respawn on
 * unmanaged Windows installs because there is no safe in-process fallback once
 * the installed package contents have been replaced.
 */
declare function respawnGatewayProcessForUpdate(opts?: GatewayRespawnOptions): GatewayUpdateRespawnResult;
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
  reason?: string;
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
  restartTrace?: {
    startedAt: number;
    lastAt: number;
  };
};
declare function writeGatewayRestartHandoffSync(opts: {
  env?: NodeJS.ProcessEnv;
  pid?: number;
  processInstanceId?: string;
  reason?: string;
  source?: GatewayRestartHandoffSource;
  restartKind: GatewayRestartHandoffRestartKind;
  supervisorMode?: GatewayRestartHandoffSupervisorMode | null;
  restartTrace?: GatewayRestartHandoff["restartTrace"];
  ttlMs?: number;
  createdAt?: number;
}): GatewayRestartHandoff | null;
//#endregion
//#region src/infra/supervisor-markers.d.ts
type RespawnSupervisor = "launchd" | "systemd" | "schtasks";
declare function detectRespawnSupervisor(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): RespawnSupervisor | null;
//#endregion
//#region src/logging/diagnostic-stability-bundle.d.ts
type DiagnosticHeapSpaceSummary = {
  spaceName: string;
  spaceSizeBytes: number;
  spaceUsedBytes: number;
  spaceAvailableBytes: number;
  physicalSpaceSizeBytes: number;
};
type DiagnosticHeapStatisticsSummary = {
  totalHeapSizeBytes: number;
  totalHeapSizeExecutableBytes: number;
  totalPhysicalSizeBytes: number;
  totalAvailableSizeBytes: number;
  usedHeapSizeBytes: number;
  heapSizeLimitBytes: number;
  mallocedMemoryBytes: number;
  externalMemoryBytes: number;
};
type DiagnosticActiveResourceSummary = {
  total: number;
  byType: Record<string, number>;
};
type DiagnosticCgroupMemorySummary = {
  version: "v2";
  values: Record<string, number | "max">;
  events: Record<string, number>;
};
type DiagnosticSessionFileSummary = {
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
};
type DiagnosticMemoryPressureBundleEvidence = {
  level: DiagnosticMemoryPressureEvent["level"];
  reason: DiagnosticMemoryPressureEvent["reason"];
  memory: DiagnosticMemoryUsage;
  thresholdBytes?: number;
  rssGrowthBytes?: number;
  windowMs?: number;
  heapStatistics?: DiagnosticHeapStatisticsSummary;
  heapSpaces?: DiagnosticHeapSpaceSummary[];
  cgroup?: DiagnosticCgroupMemorySummary;
  activeResources?: DiagnosticActiveResourceSummary;
  topSessionFiles?: DiagnosticSessionFileSummary[];
};
type DiagnosticStabilityBundleEvidence = {
  memoryPressure?: DiagnosticMemoryPressureBundleEvidence;
};
type WriteDiagnosticStabilityBundleOptions = {
  reason: string;
  error?: unknown;
  includeEmpty?: boolean;
  limit?: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  retention?: number;
  evidence?: DiagnosticStabilityBundleEvidence;
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
export { abortEmbeddedPiRun, consumeGatewayRestartIntentPayloadSync, consumeGatewayRestartIntentSync, consumeGatewaySigusr1RestartAuthorization, detectRespawnSupervisor, getActiveEmbeddedRunCount, getActiveTaskCount, getInspectableActiveTaskRestartBlockers, getRuntimeConfig, isGatewaySigusr1RestartExternallyAllowed, listActiveEmbeddedRunSessionIds, listActiveEmbeddedRunSessionKeys, markGatewayDraining, markGatewaySigusr1RestartHandled, markRestartAbortedMainSessions, markUpdateRestartSentinelFailure, peekGatewaySigusr1RestartReason, reloadTaskRegistryFromStore, resetAllLanes, resetGatewayRestartStateForInProcessRestart, resolveGatewayRestartDeferralTimeoutMs, respawnGatewayProcessForUpdate, restartGatewayProcessWithFreshPid, scheduleGatewaySigusr1Restart, waitForActiveEmbeddedRuns, waitForActiveTasks, writeDiagnosticStabilityBundleForFailureSync, writeGatewayRestartHandoffSync };