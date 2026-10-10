import path from "node:path";
import {
  asFiniteNumber,
  resolveOptionalIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
  CLI_WATCHDOG_MIN_TIMEOUT_MS,
} from "../cli-watchdog-defaults.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";
import type { EmbeddedRunTrigger } from "../run-trigger.js";

export function resolveCliNoOutputTimeoutMs(params: {
  backend: CliBackendConfig;
  timeoutMs: number;
  useResume: boolean;
  expectedQuiet?: boolean;
  trigger?: EmbeddedRunTrigger;
  runTimeoutOverrideMs?: number;
}): number {
  if (params.expectedQuiet) {
    // Expected-quiet controls have no earlier liveness signal; the caller's
    // overall operation timeout remains their authoritative execution budget.
    return params.timeoutMs;
  }
  const hasExplicitRunTimeout =
    typeof params.runTimeoutOverrideMs === "number" &&
    Number.isFinite(params.runTimeoutOverrideMs) &&
    params.runTimeoutOverrideMs > 0;
  const configured = params.useResume
    ? params.backend.reliability?.watchdog?.resume
    : params.backend.reliability?.watchdog?.fresh;
  const defaults =
    params.useResume && !configured && (params.trigger === "cron" || hasExplicitRunTimeout)
      ? CLI_FRESH_WATCHDOG_DEFAULTS
      : params.useResume
        ? CLI_RESUME_WATCHDOG_DEFAULTS
        : CLI_FRESH_WATCHDOG_DEFAULTS;
  const ratio = asFiniteNumber(configured?.noOutputTimeoutRatio);
  const noOutputTimeoutRatio =
    ratio === undefined ? defaults.noOutputTimeoutRatio : Math.max(0.05, Math.min(0.95, ratio));
  const minMs =
    resolveOptionalIntegerOption(configured?.minMs, { min: CLI_WATCHDOG_MIN_TIMEOUT_MS }) ??
    defaults.minMs;
  const maxMs =
    resolveOptionalIntegerOption(configured?.maxMs, { min: CLI_WATCHDOG_MIN_TIMEOUT_MS }) ??
    defaults.maxMs;
  // Keep watchdog below global timeout in normal cases.
  const cap = Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, params.timeoutMs - 1_000);
  const computed = Math.floor(params.timeoutMs * noOutputTimeoutRatio);
  const bounded = Math.min(Math.max(minMs, maxMs), Math.max(Math.min(minMs, maxMs), computed));
  return Math.min(bounded, cap);
}

export function resolveCliRunTimeoutOverrideMs(params: {
  config?: OpenClawConfig;
  lane?: string;
  timeoutMs: number;
  runTimeoutOverrideMs?: number;
}): number | undefined {
  if (params.runTimeoutOverrideMs !== undefined) {
    return params.runTimeoutOverrideMs;
  }
  const configuredTimeoutSeconds = params.config?.agents?.defaults?.timeoutSeconds;
  const hasConfiguredTimeout =
    params.lane !== AGENT_LANE_SUBAGENT &&
    typeof configuredTimeoutSeconds === "number" &&
    Number.isFinite(configuredTimeoutSeconds) &&
    configuredTimeoutSeconds > 0;
  return hasConfiguredTimeout ? params.timeoutMs : undefined;
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
