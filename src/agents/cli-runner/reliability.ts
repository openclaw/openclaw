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
} {
  const defaults = useResume ? CLI_RESUME_WATCHDOG_DEFAULTS : CLI_FRESH_WATCHDOG_DEFAULTS;
  const configured = useResume
    ? backend.reliability?.watchdog?.resume
    : backend.reliability?.watchdog?.fresh;

  const ratio = (() => {
    const value = configured?.noOutputTimeoutRatio;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return defaults.noOutputTimeoutRatio;
    }
    return Math.max(0.05, Math.min(0.95, value));
  })();
  const minMs = (() => {
    const value = configured?.minMs;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return defaults.minMs;
    }
    return Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(value));
  })();
  const maxMs = (() => {
    const value = configured?.maxMs;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return defaults.maxMs;
    }
    return Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(value));
  })();

  return {
    noOutputTimeoutMs:
      typeof configured?.noOutputTimeoutMs === "number" &&
      Number.isFinite(configured.noOutputTimeoutMs)
        ? Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(configured.noOutputTimeoutMs))
        : undefined,
    noOutputTimeoutRatio: ratio,
    minMs: Math.min(minMs, maxMs),
    maxMs: Math.max(minMs, maxMs),
  };
}

export function resolveCliNoOutputTimeoutMs(params: {
  backend: CliBackendConfig;
  timeoutMs: number;
  useResume: boolean;
}): number {
  const profile = pickWatchdogProfile(params.backend, params.useResume);
  // Keep watchdog below global timeout in normal cases.
  const cap = Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, params.timeoutMs - 1_000);
  if (profile.noOutputTimeoutMs !== undefined) {
    return Math.min(profile.noOutputTimeoutMs, cap);
  }
  const computed = Math.floor(params.timeoutMs * profile.noOutputTimeoutRatio);
  // When the caller's timeoutMs is much larger than the default profile (e.g. an
  // explicitly configured cron timeoutSeconds > 180s with the resume profile),
  // scale the watchdog ceiling with the configured timeout instead of silently
  // clamping to the static profile.maxMs default. The static cap remains a
  // floor for the ceiling, so default behavior is preserved at small timeouts.
  // Issue #76289.
  const effectiveMaxMs = Math.max(profile.maxMs, computed);
  const bounded = Math.min(effectiveMaxMs, Math.max(profile.minMs, computed));
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
