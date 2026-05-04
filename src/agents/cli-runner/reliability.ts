import path from "node:path";
import type { CliBackendConfig } from "../../config/types.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
  CLI_WATCHDOG_MIN_TIMEOUT_MS,
} from "../cli-watchdog-defaults.js";

function pickWatchdogProfile(
  backend: CliBackendConfig,
  useResume: boolean,
): {
  noOutputTimeoutMs?: number;
  noOutputTimeoutRatio: number;
  minMs: number;
  maxMs: number;
  maxMsConfigured: boolean;
  noOutputTimeoutRatioConfigured: boolean;
} {
  const defaults = useResume ? CLI_RESUME_WATCHDOG_DEFAULTS : CLI_FRESH_WATCHDOG_DEFAULTS;
  const configured = useResume
    ? backend.reliability?.watchdog?.resume
    : backend.reliability?.watchdog?.fresh;

  const configuredRatio = configured?.noOutputTimeoutRatio;
  const noOutputTimeoutRatioConfigured =
    typeof configuredRatio === "number" && Number.isFinite(configuredRatio);
  const ratio = noOutputTimeoutRatioConfigured
    ? Math.max(0.05, Math.min(0.95, configuredRatio))
    : defaults.noOutputTimeoutRatio;
  const minMs = (() => {
    const value = configured?.minMs;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return defaults.minMs;
    }
    return Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(value));
  })();
  const configuredMaxMs = configured?.maxMs;
  const maxMsConfigured = typeof configuredMaxMs === "number" && Number.isFinite(configuredMaxMs);
  const maxMs = maxMsConfigured
    ? Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(configuredMaxMs))
    : defaults.maxMs;

  return {
    noOutputTimeoutMs:
      typeof configured?.noOutputTimeoutMs === "number" &&
      Number.isFinite(configured.noOutputTimeoutMs)
        ? Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(configured.noOutputTimeoutMs))
        : undefined,
    noOutputTimeoutRatio: ratio,
    minMs: Math.min(minMs, maxMs),
    maxMs: Math.max(minMs, maxMs),
    maxMsConfigured,
    noOutputTimeoutRatioConfigured,
  };
}

export function resolveCliNoOutputTimeoutMs(params: {
  backend: CliBackendConfig;
  timeoutMs: number;
  useResume: boolean;
  trigger?: string;
}): number {
  const profile = pickWatchdogProfile(params.backend, params.useResume);
  // Keep watchdog below global timeout in normal cases.
  const cap = Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, params.timeoutMs - 1_000);
  if (profile.noOutputTimeoutMs !== undefined) {
    return Math.min(profile.noOutputTimeoutMs, cap);
  }
  const isCronRun = params.trigger === "cron";
  const shouldLiftDefaultResumeRatio =
    isCronRun && params.useResume && !profile.noOutputTimeoutRatioConfigured;
  const noOutputTimeoutRatio = shouldLiftDefaultResumeRatio
    ? Math.max(profile.noOutputTimeoutRatio, CLI_FRESH_WATCHDOG_DEFAULTS.noOutputTimeoutRatio)
    : profile.noOutputTimeoutRatio;
  const maxMs =
    isCronRun && !profile.maxMsConfigured ? Math.max(profile.maxMs, cap) : profile.maxMs;
  const computed = Math.floor(params.timeoutMs * noOutputTimeoutRatio);
  const bounded = Math.min(maxMs, Math.max(profile.minMs, computed));
  return Math.min(bounded, cap);
}

export function buildCliSupervisorScopeKey(params: {
  backend: CliBackendConfig;
  backendId: string;
  cliSessionId?: string;
}): string | undefined {
  const commandToken = normalizeLowercaseStringOrEmpty(path.basename(params.backend.command ?? ""));
  const backendToken = normalizeLowercaseStringOrEmpty(params.backendId);
  const sessionToken = params.cliSessionId?.trim();
  if (!sessionToken) {
    return undefined;
  }
  return `cli:${backendToken}:${commandToken}:${sessionToken}`;
}
