import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayWaitCallTimeoutMs } from "../gateway/call-timeouts.js";

export const DEFAULT_SUBAGENT_STARTUP_WAIT_TIMEOUT_MS = 10_000;
export const DEFAULT_SUBAGENT_CONTROL_TIMEOUT_MS = 10_000;
export const DEFAULT_SUBAGENT_COMPLETION_ANNOUNCE_TIMEOUT_MS = 90_000;
export const DEFAULT_SUBAGENT_CLEANUP_TIMEOUT_MS = 10_000;
const MAX_SAFE_TIMEOUT_MS = 2_147_483_647;

function clampSafeTimeoutMs(timeoutMs: number): number {
  return Math.max(1, Math.min(Math.floor(timeoutMs), MAX_SAFE_TIMEOUT_MS));
}

function readConfiguredTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? clampSafeTimeoutMs(value)
    : undefined;
}

export function resolveSubagentStartupWaitTimeoutMs(config?: OpenClawConfig): number {
  return (
    readConfiguredTimeoutMs(config?.agents?.defaults?.subagents?.startupWaitTimeoutMs) ??
    DEFAULT_SUBAGENT_STARTUP_WAIT_TIMEOUT_MS
  );
}

export function resolveSubagentControlTimeoutMs(config?: OpenClawConfig): number {
  return (
    readConfiguredTimeoutMs(config?.agents?.defaults?.subagents?.controlTimeoutMs) ??
    resolveSubagentStartupWaitTimeoutMs(config)
  );
}

export function resolveSubagentCompletionAnnounceTimeoutMs(config?: OpenClawConfig): number {
  return (
    readConfiguredTimeoutMs(config?.agents?.defaults?.subagents?.completionAnnounceTimeoutMs) ??
    readConfiguredTimeoutMs(config?.agents?.defaults?.subagents?.announceTimeoutMs) ??
    DEFAULT_SUBAGENT_COMPLETION_ANNOUNCE_TIMEOUT_MS
  );
}

export function resolveSubagentCleanupTimeoutMs(config?: OpenClawConfig): number {
  return (
    readConfiguredTimeoutMs(config?.agents?.defaults?.subagents?.cleanupTimeoutMs) ??
    resolveSubagentControlTimeoutMs(config)
  );
}

export function resolveSubagentWaitGatewayTimeoutMs(
  config: OpenClawConfig | undefined,
  waitTimeoutMs: number,
): number {
  return resolveGatewayWaitCallTimeoutMs(config, waitTimeoutMs);
}
