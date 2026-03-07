import path from "node:path";
import type { CliBackendConfig } from "../../config/types.js";
import type { OverallTimeoutPolicy } from "../../process/supervisor/types.js";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
  CLI_WATCHDOG_DEFAULT_EVIDENCE_MAX_CHARS,
  CLI_WATCHDOG_DEFAULT_EVIDENCE_TAIL_LINES,
  CLI_WATCHDOG_DEFAULT_EXTEND_OVERALL_MAX_FLOOR_MS,
  CLI_WATCHDOG_DEFAULT_EXTEND_OVERALL_MAX_MULTIPLIER,
  CLI_WATCHDOG_DEFAULT_OVERALL_POLICY,
  CLI_WATCHDOG_MIN_TIMEOUT_MS,
} from "../cli-watchdog-defaults.js";

type WatchdogModeConfig = {
  noOutputTimeoutMs?: number;
  noOutputTimeoutRatio: number;
  minMs: number;
  maxMs: number;
  overallPolicy: OverallTimeoutPolicy;
  overallMaxMs?: number;
  evidenceTailLines: number;
  evidenceMaxChars: number;
};

export type ResolvedCliWatchdog = {
  noOutputTimeoutMs: number;
  overallPolicy: OverallTimeoutPolicy;
  overallMaxMs?: number;
  evidenceTailLines: number;
  evidenceMaxChars: number;
};

function clampInt(value: number | undefined, min: number, max: number, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function pickWatchdogProfile(backend: CliBackendConfig, useResume: boolean): WatchdogModeConfig {
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
  const overallPolicy: OverallTimeoutPolicy =
    configured?.overallPolicy ?? CLI_WATCHDOG_DEFAULT_OVERALL_POLICY;
  const overallMaxMs =
    typeof configured?.overallMaxMs === "number" && Number.isFinite(configured.overallMaxMs)
      ? Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(configured.overallMaxMs))
      : undefined;

  return {
    noOutputTimeoutMs:
      typeof configured?.noOutputTimeoutMs === "number" &&
      Number.isFinite(configured.noOutputTimeoutMs)
        ? Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(configured.noOutputTimeoutMs))
        : undefined,
    noOutputTimeoutRatio: ratio,
    minMs: Math.min(minMs, maxMs),
    maxMs: Math.max(minMs, maxMs),
    overallPolicy,
    overallMaxMs,
    evidenceTailLines: clampInt(
      configured?.evidence?.tailLines,
      1,
      200,
      CLI_WATCHDOG_DEFAULT_EVIDENCE_TAIL_LINES,
    ),
    evidenceMaxChars: clampInt(
      configured?.evidence?.maxChars,
      200,
      40_000,
      CLI_WATCHDOG_DEFAULT_EVIDENCE_MAX_CHARS,
    ),
  };
}

export function resolveCliWatchdog(params: {
  backend: CliBackendConfig;
  timeoutMs: number;
  useResume: boolean;
}): ResolvedCliWatchdog {
  const profile = pickWatchdogProfile(params.backend, params.useResume);
  // Keep no-output watchdog below global timeout in normal cases.
  const cap = Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, params.timeoutMs - 1_000);
  const noOutputTimeoutMs =
    profile.noOutputTimeoutMs !== undefined
      ? Math.min(profile.noOutputTimeoutMs, cap)
      : Math.min(
          Math.min(
            profile.maxMs,
            Math.max(profile.minMs, Math.floor(params.timeoutMs * profile.noOutputTimeoutRatio)),
          ),
          cap,
        );
  const defaultExtendOverallMaxMs = Math.max(
    CLI_WATCHDOG_DEFAULT_EXTEND_OVERALL_MAX_FLOOR_MS,
    Math.floor(params.timeoutMs * CLI_WATCHDOG_DEFAULT_EXTEND_OVERALL_MAX_MULTIPLIER),
  );
  const overallMaxMs =
    profile.overallPolicy === "extend-on-output"
      ? Math.max(params.timeoutMs, profile.overallMaxMs ?? defaultExtendOverallMaxMs)
      : profile.overallMaxMs;

  return {
    noOutputTimeoutMs,
    overallPolicy: profile.overallPolicy,
    overallMaxMs,
    evidenceTailLines: profile.evidenceTailLines,
    evidenceMaxChars: profile.evidenceMaxChars,
  };
}

export function resolveCliNoOutputTimeoutMs(params: {
  backend: CliBackendConfig;
  timeoutMs: number;
  useResume: boolean;
}): number {
  return resolveCliWatchdog(params).noOutputTimeoutMs;
}

export function buildCliSupervisorScopeKey(params: {
  backend: CliBackendConfig;
  backendId: string;
  cliSessionId?: string;
}): string | undefined {
  const commandToken = path
    .basename(params.backend.command ?? "")
    .trim()
    .toLowerCase();
  const backendToken = params.backendId.trim().toLowerCase();
  const sessionToken = params.cliSessionId?.trim();
  if (!sessionToken) {
    return undefined;
  }
  return `cli:${backendToken}:${commandToken}:${sessionToken}`;
}
