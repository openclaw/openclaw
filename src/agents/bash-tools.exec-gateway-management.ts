import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { isRestartEnabled } from "../config/commands.js";
import { loadConfig } from "../config/config.js";
import { extractDeliveryInfo } from "../config/sessions/delivery-info.js";
import {
  LEGACY_GATEWAY_WINDOWS_TASK_NAMES,
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  normalizeGatewayProfile,
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../daemon/constants.js";
import { resolveGatewayService } from "../daemon/service.js";
import { consumeRootOptionToken, FLAG_TERMINATOR } from "../infra/cli-root-options.js";
import { analyzeShellCommand } from "../infra/exec-approvals-analysis.js";
import {
  evaluateShellAllowlist,
  requiresExecApproval,
  type ExecAsk,
  type ExecHost,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import type { SafeBinProfile } from "../infra/exec-safe-bin-policy.js";
import { normalizeExecutableToken } from "../infra/exec-wrapper-resolution.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../infra/restart.js";
import { logInfo } from "../logger.js";
import { splitShellArgs } from "../utils/shell-argv.js";
import { resolveExecHostApprovalContext } from "./bash-tools.exec-host-shared.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";

const RUNNER_BINS = new Set(["pnpm", "npx", "bunx"]);
const RESTART_REASON = "exec:gateway-restart";
const SYSTEMCTL_ACTIONS = new Set(["restart", "start", "stop"]);
const LAUNCHCTL_ACTIONS = new Map<string, GatewayManagementAction>([
  ["kickstart", "restart"],
  ["bootstrap", "start"],
  ["bootout", "stop"],
  ["load", "start"],
  ["unload", "stop"],
  ["start", "start"],
  ["stop", "stop"],
]);
const SCHTASKS_ACTIONS = new Map<string, GatewayManagementAction>([
  ["/run", "restart"],
  ["/end", "stop"],
]);
const PNPM_BOOLEAN_OPTIONS = new Set([
  "-c",
  "-r",
  "-w",
  "--aggregate-output",
  "--color",
  "--fail-if-no-match",
  "--include-workspace-root",
  "--link-workspace-packages",
  "--no-bail",
  "--no-color",
  "--no-reporter-hide-prefix",
  "--no-sort",
  "--parallel",
  "--reverse",
  "--recursive",
  "--report-summary",
  "--shell-mode",
  "--shared-workspace-lockfile",
  "--silent",
  "--sort",
  "--stream",
  "--use-stderr",
  "--workspace-root",
]);
const PNPM_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-p",
  "--changed-files-ignore-pattern",
  "--dir",
  "--filter",
  "--filter-prod",
  "--loglevel",
  "--package",
  "--reporter",
  "--resume-from",
  "--test-pattern",
  "--workspace-concurrency",
]);
const BUNX_BOOLEAN_OPTIONS = new Set(["--bun", "--no-install", "--verbose", "--silent"]);
const BUNX_OPTIONS_WITH_VALUE = new Set(["-p", "--package"]);
const NPM_EXEC_BOOLEAN_OPTIONS = new Set(["--include-workspace-root", "--workspaces"]);
const NPM_EXEC_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "--call",
  "-p",
  "--package",
  "-w",
  "--workspace",
]);
const CLI_HELP_OR_VERSION_FLAGS = new Set(["-h", "--help", "-v", "--version"]);
const GATEWAY_SERVICE_BOOLEAN_FLAGS = new Set(["--json"]);
const GATEWAY_RESTART_EXTRA_FLAGS = new Set(["--hard"]);
const SYSTEMCTL_HELP_OR_VERSION_FLAGS = new Set(["-h", "--help", "--version"]);
const SYSTEMCTL_BOOLEAN_OPTIONS = new Set([
  "--no-block",
  "--no-ask-password",
  "--no-pager",
  "--quiet",
  "--system",
  "--user",
  "--wait",
  "-q",
]);
const SYSTEMCTL_OPTIONS_WITH_VALUE = new Set(["-H", "--host", "-M", "--machine", "--job-mode"]);
const SHELL_CONTROL_TOKENS = new Set(["&&", "||", "&", ";", "|", ">", ">>", "<", "<<"]);
const WINDOWS_FALLBACK_CONTROL_CHARS = new Set(["&", "|", ";", "<", ">"]);
const SHELL_CONTROL_CHARS = new Set(["&", "|", ";", "<", ">", "$", "`", "(", ")"]);

export type GatewayManagementExecSource = "openclaw-cli" | "systemctl" | "launchctl" | "schtasks";

export type GatewayManagementAction = "restart" | "start" | "stop";

export type GatewayManagementExecCommand = {
  action: GatewayManagementAction;
  source: GatewayManagementExecSource;
  hard: boolean;
  complex: boolean;
  json?: boolean;
};

const GATEWAY_IDENTITY_ENV_KEYS = [
  "OPENCLAW_PROFILE",
  "OPENCLAW_SYSTEMD_UNIT",
  "OPENCLAW_LAUNCHD_LABEL",
  "OPENCLAW_WINDOWS_TASK_NAME",
] as const;

function normalizeLower(token: string | undefined): string {
  return token?.trim().toLowerCase() ?? "";
}

function isOpenclawPackageExecutable(token: string | undefined): boolean {
  const normalized = normalizeExecutableToken(token ?? "");
  return (
    normalized === "openclaw" ||
    (normalized.startsWith("openclaw@") && normalized.length > "openclaw@".length)
  );
}

function stripSurroundingQuotes(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function basenameLower(token: string): string {
  const cleaned = stripSurroundingQuotes(token).replace(/\\/g, "/");
  const pieces = cleaned.split("/");
  return (pieces[pieces.length - 1] ?? "").trim().toLowerCase();
}

function stripTrailingShellControlChars(token: string): string {
  return token.replace(/[&|;<>]+$/g, "");
}

function hasUnquotedWindowsFallbackControlChar(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (const ch of command) {
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && WINDOWS_FALLBACK_CONTROL_CHARS.has(ch)) {
      return true;
    }
  }
  return false;
}

function hasShellControlChar(token: string): boolean {
  for (const ch of token) {
    if (SHELL_CONTROL_CHARS.has(ch)) {
      return true;
    }
  }
  return false;
}

function normalizeSystemdUnitToken(token: string): string {
  const base = basenameLower(token);
  return base.endsWith(".service") ? base.slice(0, -".service".length) : base;
}

function collectGatewaySystemdUnitBases(env: NodeJS.ProcessEnv): Set<string> {
  const units = new Set<string>();
  const configured = normalizeSystemdUnitToken(env.OPENCLAW_SYSTEMD_UNIT ?? "");
  if (configured) {
    units.add(configured);
    return units;
  }

  const currentProfile = normalizeGatewayProfile(env.OPENCLAW_PROFILE) ?? undefined;
  units.add(resolveGatewaySystemdServiceName(currentProfile).toLowerCase());
  if (!currentProfile) {
    for (const legacy of LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES) {
      units.add(legacy.toLowerCase());
    }
  }

  return units;
}

function isGatewaySystemdUnitToken(token: string, env: NodeJS.ProcessEnv): boolean {
  const normalized = normalizeSystemdUnitToken(token);
  if (!normalized) {
    return false;
  }

  const knownBases = collectGatewaySystemdUnitBases(env);
  return knownBases.has(normalized);
}

function collectGatewayLaunchdLabels(env: NodeJS.ProcessEnv): Set<string> {
  const labels = new Set<string>();
  const configured = normalizeLower(env.OPENCLAW_LAUNCHD_LABEL);
  if (configured) {
    labels.add(configured);
    return labels;
  }

  const currentProfile = normalizeGatewayProfile(env.OPENCLAW_PROFILE) ?? undefined;
  labels.add(resolveGatewayLaunchAgentLabel(currentProfile).toLowerCase());

  return labels;
}

function isGatewayLaunchctlTarget(token: string, env: NodeJS.ProcessEnv): boolean {
  const raw = stripSurroundingQuotes(token).trim();
  if (!raw) {
    return false;
  }

  const labels = collectGatewayLaunchdLabels(env);
  const lower = raw.toLowerCase();
  if (labels.has(lower)) {
    return true;
  }

  const maybeDomainLabel = lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
  if (labels.has(maybeDomainLabel)) {
    return true;
  }

  const base = basenameLower(raw);
  if (base.endsWith(".plist")) {
    const fromPlist = base.slice(0, -".plist".length);
    if (labels.has(fromPlist)) {
      return true;
    }
  }

  return false;
}

function collectGatewayWindowsTaskNames(env: NodeJS.ProcessEnv): Set<string> {
  const names = new Set<string>();
  const configured = normalizeLower(env.OPENCLAW_WINDOWS_TASK_NAME);
  if (configured) {
    names.add(configured);
    return names;
  }

  const currentProfile = normalizeGatewayProfile(env.OPENCLAW_PROFILE) ?? undefined;
  names.add(resolveGatewayWindowsTaskName(currentProfile).toLowerCase());
  if (!currentProfile) {
    for (const legacy of LEGACY_GATEWAY_WINDOWS_TASK_NAMES) {
      names.add(legacy.toLowerCase());
    }
  }

  return names;
}

function isGatewayWindowsTaskName(token: string, env: NodeJS.ProcessEnv): boolean {
  const normalized = stripSurroundingQuotes(token).trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const known = collectGatewayWindowsTaskNames(env);
  return known.has(normalized);
}

function normalizeIdentityValue(
  key: (typeof GATEWAY_IDENTITY_ENV_KEYS)[number],
  value: string | undefined,
) {
  if (!value?.trim()) {
    return null;
  }
  if (key === "OPENCLAW_PROFILE") {
    return normalizeGatewayProfile(value);
  }
  if (key === "OPENCLAW_SYSTEMD_UNIT") {
    const normalized = normalizeSystemdUnitToken(value);
    return normalized || null;
  }
  return normalizeLower(value) || null;
}

function requestEnvRetargetsGatewayIdentity(params: {
  runtimeEnv: NodeJS.ProcessEnv;
  requestedEnv?: NodeJS.ProcessEnv | null;
}): boolean {
  const requestedEnv = params.requestedEnv;
  if (!requestedEnv) {
    return false;
  }

  for (const key of GATEWAY_IDENTITY_ENV_KEYS) {
    if (!(key in requestedEnv)) {
      continue;
    }
    const runtimeIdentity = normalizeIdentityValue(key, params.runtimeEnv[key]);
    const requestedIdentity = normalizeIdentityValue(key, requestedEnv[key]);
    if (runtimeIdentity !== requestedIdentity) {
      return true;
    }
  }

  return false;
}

function hasSystemctlRemoteScope(argv: string[]): boolean {
  for (let idx = 1; idx < argv.length; idx += 1) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      continue;
    }
    if (token === "--") {
      break;
    }
    const lower = token.toLowerCase();
    if (
      token === "-H" ||
      token === "-M" ||
      (token.startsWith("-H") && token.length > 2) ||
      (token.startsWith("-M") && token.length > 2) ||
      lower === "--host" ||
      lower.startsWith("--host=") ||
      lower === "--machine" ||
      lower.startsWith("--machine=")
    ) {
      return true;
    }
  }
  return false;
}

function hasSystemctlManagerScope(argv: string[]): boolean {
  for (let idx = 1; idx < argv.length; idx += 1) {
    const token = normalizeLower(argv[idx]);
    if (!token) {
      continue;
    }
    if (token === FLAG_TERMINATOR) {
      break;
    }
    if (token === "--system" || token === "--user") {
      return true;
    }
  }
  return false;
}

function hasSystemctlHelpOrVersion(argv: string[]): boolean {
  for (let idx = 1; idx < argv.length; idx += 1) {
    const token = normalizeLower(argv[idx]);
    if (!token) {
      continue;
    }
    if (token === FLAG_TERMINATOR) {
      break;
    }
    if (SYSTEMCTL_HELP_OR_VERSION_FLAGS.has(token)) {
      return true;
    }
  }
  return false;
}

function consumePnpmOption(argv: string[], idx: number): number | null {
  const token = argv[idx]?.trim() ?? "";
  if (!token.startsWith("-")) {
    return 0;
  }

  if (token.startsWith("--")) {
    const equalsIdx = token.indexOf("=");
    const rawFlag = equalsIdx === -1 ? token : token.slice(0, equalsIdx);
    const flag = rawFlag.toLowerCase();
    const hasInlineValue = equalsIdx !== -1;
    const inlineValue = hasInlineValue ? token.slice(equalsIdx + 1).trim() : "";

    if (PNPM_BOOLEAN_OPTIONS.has(flag)) {
      return hasInlineValue ? null : 1;
    }
    if (!PNPM_OPTIONS_WITH_VALUE.has(flag)) {
      return null;
    }
    if (hasInlineValue) {
      return inlineValue ? 1 : null;
    }
    if (idx + 1 >= argv.length) {
      return null;
    }
    const next = argv[idx + 1]?.trim() ?? "";
    if (!next || next === FLAG_TERMINATOR || next.startsWith("-")) {
      return null;
    }
    return 2;
  }

  if (token === "-C") {
    const next = argv[idx + 1]?.trim() ?? "";
    if (!next || next === FLAG_TERMINATOR || next.startsWith("-")) {
      return null;
    }
    return 2;
  }
  if (token.startsWith("-C") && token.length > 2) {
    return 1;
  }
  if (PNPM_BOOLEAN_OPTIONS.has(token)) {
    return token.length === 2 ? 1 : null;
  }
  return null;
}

function consumeNpmExecOption(
  argv: string[],
  idx: number,
): {
  consumed: number;
  call?: string;
} | null {
  const token = argv[idx]?.trim() ?? "";
  if (!token.startsWith("-")) {
    return { consumed: 0 };
  }

  if (token.startsWith("--")) {
    const equalsIdx = token.indexOf("=");
    const rawFlag = equalsIdx === -1 ? token : token.slice(0, equalsIdx);
    const flag = rawFlag.toLowerCase();
    const hasInlineValue = equalsIdx !== -1;
    const inlineValue = hasInlineValue ? token.slice(equalsIdx + 1).trim() : "";

    if (NPM_EXEC_BOOLEAN_OPTIONS.has(flag)) {
      return hasInlineValue ? null : { consumed: 1 };
    }
    if (!NPM_EXEC_OPTIONS_WITH_VALUE.has(flag)) {
      return null;
    }
    if (hasInlineValue) {
      if (!inlineValue) {
        return null;
      }
      return flag === "--call" ? { consumed: 1, call: inlineValue } : { consumed: 1 };
    }
    const next = argv[idx + 1]?.trim() ?? "";
    if (!next || next === FLAG_TERMINATOR || next.startsWith("-")) {
      return null;
    }
    return flag === "--call" ? { consumed: 2, call: next } : { consumed: 2 };
  }

  const shortFlag = token.slice(0, 2).toLowerCase();
  const hasInlineValue = token.length > 2;
  if (NPM_EXEC_BOOLEAN_OPTIONS.has(shortFlag)) {
    return hasInlineValue ? null : { consumed: 1 };
  }
  if (!NPM_EXEC_OPTIONS_WITH_VALUE.has(shortFlag)) {
    return null;
  }
  const inlineValue = hasInlineValue ? token.slice(2).trim() : "";
  if (hasInlineValue) {
    if (!inlineValue) {
      return null;
    }
    return shortFlag === "-c" ? { consumed: 1, call: inlineValue } : { consumed: 1 };
  }
  const next = argv[idx + 1]?.trim() ?? "";
  if (!next || next === FLAG_TERMINATOR || next.startsWith("-")) {
    return null;
  }
  return shortFlag === "-c" ? { consumed: 2, call: next } : { consumed: 2 };
}

function consumeBunxOption(argv: string[], idx: number): number | null {
  const token = argv[idx]?.trim() ?? "";
  if (!token.startsWith("-")) {
    return 0;
  }

  if (token.startsWith("--")) {
    const equalsIdx = token.indexOf("=");
    const rawFlag = equalsIdx === -1 ? token : token.slice(0, equalsIdx);
    const flag = rawFlag.toLowerCase();
    const hasInlineValue = equalsIdx !== -1;
    const inlineValue = hasInlineValue ? token.slice(equalsIdx + 1).trim() : "";

    if (BUNX_BOOLEAN_OPTIONS.has(flag)) {
      return hasInlineValue ? null : 1;
    }
    if (!BUNX_OPTIONS_WITH_VALUE.has(flag)) {
      return null;
    }
    if (hasInlineValue) {
      return inlineValue ? 1 : null;
    }
    const next = argv[idx + 1]?.trim() ?? "";
    if (!next || next === FLAG_TERMINATOR || next.startsWith("-")) {
      return null;
    }
    return 2;
  }

  const shortFlag = token.slice(0, 2).toLowerCase();
  const hasInlineValue = token.length > 2;
  if (!BUNX_OPTIONS_WITH_VALUE.has(shortFlag)) {
    return null;
  }
  if (hasInlineValue) {
    return token.slice(2).trim() ? 1 : null;
  }
  const next = argv[idx + 1]?.trim() ?? "";
  if (!next || next === FLAG_TERMINATOR || next.startsWith("-")) {
    return null;
  }
  return 2;
}

function readPnpmCliArgv(argv: string[]): string[] | null {
  const second = argv[1]?.trim();
  if (second && isOpenclawPackageExecutable(second)) {
    return argv.slice(2);
  }

  let idx = 1;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      idx += 1;
      break;
    }
    if (token.startsWith("-")) {
      const consumed = consumePnpmOption(argv, idx);
      if (consumed === null) {
        return null;
      }
      idx += consumed;
      continue;
    }
    break;
  }

  if (idx >= argv.length) {
    return null;
  }

  const commandToken = argv[idx]?.trim() ?? "";
  if (isOpenclawPackageExecutable(commandToken)) {
    return argv.slice(idx + 1);
  }
  const commandLower = normalizeLower(commandToken);
  if (commandLower !== "exec" && commandLower !== "dlx") {
    return null;
  }

  idx += 1;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      idx += 1;
      break;
    }
    if (token.startsWith("-")) {
      const consumed = consumePnpmOption(argv, idx);
      if (consumed === null) {
        return null;
      }
      idx += consumed;
      continue;
    }
    break;
  }

  if (idx < argv.length && isOpenclawPackageExecutable(argv[idx])) {
    return argv.slice(idx + 1);
  }
  return null;
}

function readNpmExecLikeCliArgv(argv: string[], startIdx: number): string[] | null {
  let idx = startIdx;
  let call: string | null = null;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      if (call) {
        return null;
      }
      idx += 1;
      break;
    }
    if (token.startsWith("-")) {
      const consumed = consumeNpmExecOption(argv, idx);
      if (!consumed) {
        return null;
      }
      if (consumed.call !== undefined) {
        if (call) {
          return null;
        }
        call = consumed.call;
      }
      idx += consumed.consumed;
      continue;
    }
    if (call) {
      return null;
    }
    break;
  }

  if (call) {
    const callArgv = splitShellArgs(call);
    if (!callArgv || callArgv.length === 0) {
      return null;
    }
    if (!isOpenclawPackageExecutable(callArgv[0])) {
      return null;
    }
    return callArgv.slice(1);
  }

  if (idx < argv.length && isOpenclawPackageExecutable(argv[idx])) {
    return argv.slice(idx + 1);
  }
  return null;
}

function readBunxCliArgv(argv: string[]): string[] | null {
  const second = argv[1]?.trim();
  if (second && isOpenclawPackageExecutable(second)) {
    return argv.slice(2);
  }

  let idx = 1;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      idx += 1;
      break;
    }
    if (token.startsWith("-")) {
      const consumed = consumeBunxOption(argv, idx);
      if (consumed === null) {
        return null;
      }
      idx += consumed;
      continue;
    }
    break;
  }

  if (idx < argv.length && isOpenclawPackageExecutable(argv[idx])) {
    return argv.slice(idx + 1);
  }
  return null;
}

function readCliArgv(argv: string[]): string[] | null {
  if (argv.length === 0) {
    return null;
  }

  const first = normalizeExecutableToken(argv[0]);
  if (first === "openclaw") {
    return argv.slice(1);
  }

  if (RUNNER_BINS.has(first)) {
    if (first === "pnpm") {
      return readPnpmCliArgv(argv);
    }
    if (first === "npx") {
      return readNpmExecLikeCliArgv(argv, 1);
    }
    if (first === "bunx") {
      return readBunxCliArgv(argv);
    }

    let idx = 1;
    while (idx < argv.length) {
      const token = argv[idx]?.trim();
      if (!token) {
        idx += 1;
        continue;
      }
      if (token === "--") {
        idx += 1;
        break;
      }
      if (token.startsWith("-")) {
        return null;
      }
      break;
    }
    if (idx < argv.length && isOpenclawPackageExecutable(argv[idx])) {
      return argv.slice(idx + 1);
    }
    return null;
  }

  if (first === "npm") {
    const second = normalizeLower(argv[1]);
    if (second !== "exec" && second !== "x") {
      return null;
    }
    return readNpmExecLikeCliArgv(argv, 2);
  }

  return null;
}

function parseGatewayActionFromCliArgv(
  cliArgv: string[],
  env: NodeJS.ProcessEnv,
): {
  action: GatewayManagementAction;
  hard: boolean;
  json: boolean;
  complex: boolean;
} | null {
  if (cliArgv.length < 2) {
    return null;
  }

  let gatewayIdx = -1;
  let requestedProfile: string | null | undefined;
  for (let idx = 0; idx < cliArgv.length; idx += 1) {
    const token = cliArgv[idx]?.trim() ?? "";
    if (!token) {
      continue;
    }
    if (token === FLAG_TERMINATOR) {
      return null;
    }

    if (CLI_HELP_OR_VERSION_FLAGS.has(token)) {
      return null;
    }

    if (token.startsWith("-")) {
      if (token.startsWith("--profile=")) {
        requestedProfile = normalizeGatewayProfile(token.slice("--profile=".length));
      } else if (token === "--profile") {
        const next = cliArgv[idx + 1];
        if (next === undefined) {
          return null;
        }
        requestedProfile = normalizeGatewayProfile(next);
      }
      const consumedRootOption = consumeRootOptionToken(cliArgv, idx);
      if (consumedRootOption === 0) {
        return null;
      }
      idx += consumedRootOption - 1;
      continue;
    }

    gatewayIdx = idx;
    break;
  }

  if (gatewayIdx < 0 || (cliArgv[gatewayIdx]?.trim() ?? "") !== "gateway") {
    return null;
  }
  if (gatewayIdx + 1 >= cliArgv.length) {
    return null;
  }

  const actionToken = cliArgv[gatewayIdx + 1]?.trim() ?? "";
  let action: GatewayManagementAction | null = null;
  let complex = false;
  if (actionToken === "restart" || actionToken === "start" || actionToken === "stop") {
    action = actionToken as GatewayManagementAction;
  } else {
    for (const candidate of ["restart", "start", "stop"] as const) {
      if (actionToken.startsWith(candidate) && actionToken.length > candidate.length) {
        const nextChar = actionToken[candidate.length] ?? "";
        if (nextChar && !/[a-z0-9]/.test(nextChar)) {
          action = candidate;
          complex = true;
          break;
        }
      }
    }
  }
  if (!action) {
    return null;
  }

  const trailing = new Set<string>();
  for (const rawToken of cliArgv.slice(gatewayIdx + 2)) {
    const token = rawToken.trim();
    if (!token) {
      continue;
    }
    if (token === FLAG_TERMINATOR || CLI_HELP_OR_VERSION_FLAGS.has(token)) {
      return null;
    }
    if (!token.startsWith("-")) {
      if (SHELL_CONTROL_TOKENS.has(token) || hasShellControlChar(token)) {
        complex = true;
        break;
      }
      return null;
    }
    trailing.add(token);
  }

  for (const token of trailing) {
    if (GATEWAY_SERVICE_BOOLEAN_FLAGS.has(token)) {
      continue;
    }
    if (action === "restart" && GATEWAY_RESTART_EXTRA_FLAGS.has(token)) {
      continue;
    }
    return null;
  }

  const hard = action === "restart" && trailing.has("--hard");
  const json = trailing.has("--json");

  // `openclaw --profile X gateway ...` must only be intercepted when X targets this
  // gateway process; otherwise we risk restarting the wrong profile instance.
  if (requestedProfile !== undefined) {
    const currentProfile = normalizeGatewayProfile(env.OPENCLAW_PROFILE);
    if (requestedProfile !== currentProfile) {
      return null;
    }
  }

  return { action, hard, json, complex };
}

function consumeSystemctlOption(argv: string[], idx: number): number | null {
  const token = normalizeLower(argv[idx]);
  if (!token.startsWith("-")) {
    return 0;
  }

  const equalsIdx = token.indexOf("=");
  const flag = equalsIdx === -1 ? token : token.slice(0, equalsIdx);
  const hasInlineValue = equalsIdx !== -1;
  const inlineValue = hasInlineValue ? token.slice(equalsIdx + 1).trim() : "";

  if (SYSTEMCTL_BOOLEAN_OPTIONS.has(flag)) {
    return hasInlineValue ? null : 1;
  }

  if (!SYSTEMCTL_OPTIONS_WITH_VALUE.has(flag)) {
    return null;
  }

  if (hasInlineValue) {
    return inlineValue ? 1 : null;
  }
  if (idx + 1 >= argv.length) {
    return null;
  }
  const next = argv[idx + 1]?.trim() ?? "";
  if (!next || next === FLAG_TERMINATOR || next.startsWith("-")) {
    return null;
  }
  return 2;
}

function collectSystemctlPositionals(argv: string[]): string[] | null {
  const positionals: string[] = [];
  for (let idx = 1; idx < argv.length; idx += 1) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      continue;
    }
    if (token === "--") {
      positionals.push(
        ...argv
          .slice(idx + 1)
          .map((entry) => entry.trim())
          .filter(Boolean),
      );
      break;
    }
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const consumed = consumeSystemctlOption(argv, idx);
    if (consumed === null) {
      return null;
    }
    if (consumed > 0) {
      idx += consumed - 1;
    }
  }
  return positionals;
}

function parseGatewayActionFromSystemctlArgv(
  argv: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): GatewayManagementAction | null {
  if (platform !== "linux") {
    return null;
  }
  if (normalizeExecutableToken(argv[0] ?? "") !== "systemctl") {
    return null;
  }
  if (hasSystemctlHelpOrVersion(argv)) {
    return null;
  }
  if (hasSystemctlRemoteScope(argv)) {
    return null;
  }
  if (hasSystemctlManagerScope(argv)) {
    return null;
  }

  const positionals = collectSystemctlPositionals(argv);
  if (!positionals || positionals.length < 2) {
    return null;
  }

  const action = normalizeLower(positionals[0]);
  if (!SYSTEMCTL_ACTIONS.has(action)) {
    return null;
  }

  const targets = positionals.slice(1);
  if (targets.length !== 1) {
    return null;
  }
  if (!isGatewaySystemdUnitToken(targets[0], env)) {
    return null;
  }

  return action as GatewayManagementAction;
}

function parseGatewayActionFromLaunchctlArgv(
  argv: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): GatewayManagementAction | null {
  if (platform !== "darwin") {
    return null;
  }
  if (normalizeExecutableToken(argv[0] ?? "") !== "launchctl") {
    return null;
  }

  const action = normalizeLower(argv[1]);
  const mappedAction = LAUNCHCTL_ACTIONS.get(action);
  if (!mappedAction) {
    return null;
  }

  const candidates = argv.slice(2).filter((token) => token.trim().length > 0);
  if (!candidates.some((token) => isGatewayLaunchctlTarget(token, env))) {
    return null;
  }

  return mappedAction;
}

function parseGatewayActionFromSchtasksArgv(
  argv: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): GatewayManagementAction | null {
  if (platform !== "win32") {
    return null;
  }
  if (normalizeExecutableToken(argv[0] ?? "") !== "schtasks") {
    return null;
  }

  const lowerTokens = argv.map((token) => token.trim().toLowerCase());
  const action = lowerTokens.map((token) => SCHTASKS_ACTIONS.get(token)).find(Boolean);
  if (!action) {
    return null;
  }

  let taskName: string | null = null;
  for (let idx = 0; idx < argv.length; idx += 1) {
    const raw = argv[idx]?.trim();
    if (!raw) {
      continue;
    }
    const lower = raw.toLowerCase();
    if (lower === "/tn" && idx + 1 < argv.length) {
      taskName = argv[idx + 1] ?? null;
      break;
    }
    if (lower.startsWith("/tn:")) {
      taskName = raw.slice("/tn:".length);
      break;
    }
  }

  if (!taskName || !isGatewayWindowsTaskName(taskName, env)) {
    return null;
  }

  return action;
}

function detectGatewayManagementExecCommandFromWindowsFallback(params: {
  command: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): GatewayManagementExecCommand | null {
  if (params.platform !== "win32") {
    return null;
  }

  if (hasUnquotedWindowsFallbackControlChar(params.command)) {
    return null;
  }
  const rawArgv = splitShellArgs(params.command);
  if (!rawArgv) {
    return null;
  }
  const argv = rawArgv.map((token) => token.trim());
  if (argv.length === 0 || argv.some((token) => !token || SHELL_CONTROL_TOKENS.has(token))) {
    return null;
  }

  const schtasksAction = parseGatewayActionFromSchtasksArgv(argv, params.env, params.platform);
  if (!schtasksAction) {
    return null;
  }
  return {
    action: schtasksAction,
    source: "schtasks",
    hard: false,
    complex: false,
  };
}

function parseGatewayActionFromSystemctlFallbackArgv(
  argv: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): GatewayManagementAction | null {
  if (platform !== "linux") {
    return null;
  }
  if (normalizeExecutableToken(argv[0] ?? "") !== "systemctl") {
    return null;
  }
  if (hasSystemctlHelpOrVersion(argv)) {
    return null;
  }
  if (hasSystemctlRemoteScope(argv)) {
    return null;
  }
  if (hasSystemctlManagerScope(argv)) {
    return null;
  }

  const positionals = collectSystemctlPositionals(argv);
  if (!positionals || positionals.length < 2) {
    return null;
  }

  const actionToken = normalizeLower(positionals[0]);
  let action: GatewayManagementAction | null = null;
  if (actionToken === "restart" || actionToken === "start" || actionToken === "stop") {
    action = actionToken as GatewayManagementAction;
  } else {
    for (const candidate of ["restart", "start", "stop"] as const) {
      if (actionToken.startsWith(candidate) && actionToken.length > candidate.length) {
        const nextChar = actionToken[candidate.length] ?? "";
        if (nextChar && !/[a-z0-9]/.test(nextChar)) {
          action = candidate;
          break;
        }
      }
    }
  }
  if (!action) {
    return null;
  }

  const targets = positionals.slice(1).map((token) => stripTrailingShellControlChars(token));
  if (!targets.some((target) => isGatewaySystemdUnitToken(target, env))) {
    return null;
  }

  return action;
}

function detectGatewayManagementExecCommandFromShellFallback(params: {
  command: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): GatewayManagementExecCommand | null {
  if (params.platform === "win32") {
    return null;
  }

  const argv = splitShellArgs(params.command);
  if (!argv || argv.length === 0) {
    return null;
  }

  const cliArgv = readCliArgv(argv);
  if (cliArgv) {
    const parsed = parseGatewayActionFromCliArgv(cliArgv, params.env);
    if (parsed) {
      return {
        action: parsed.action,
        source: "openclaw-cli",
        hard: parsed.hard,
        complex: true,
        ...(parsed.json ? { json: true } : {}),
      };
    }
  }

  const systemctlAction = parseGatewayActionFromSystemctlFallbackArgv(
    argv,
    params.env,
    params.platform,
  );
  if (systemctlAction) {
    return {
      action: systemctlAction,
      source: "systemctl",
      hard: false,
      complex: true,
    };
  }

  const launchctlAction = parseGatewayActionFromLaunchctlArgv(argv, params.env, params.platform);
  if (launchctlAction) {
    return {
      action: launchctlAction,
      source: "launchctl",
      hard: false,
      complex: true,
    };
  }

  return null;
}

export function detectGatewayManagementExecCommand(params: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  identityEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): GatewayManagementExecCommand | null {
  const platform = params.platform ?? process.platform;
  const identityEnv = params.identityEnv ?? params.env;
  const analysis = analyzeShellCommand({
    command: params.command,
    cwd: params.cwd,
    env: params.env,
    platform,
  });
  if (!analysis.ok || analysis.segments.length === 0) {
    const fallback = detectGatewayManagementExecCommandFromShellFallback({
      command: params.command,
      env: identityEnv,
      platform,
    });
    if (fallback) {
      return fallback;
    }
    return detectGatewayManagementExecCommandFromWindowsFallback({
      command: params.command,
      env: identityEnv,
      platform,
    });
  }

  const complex = analysis.segments.length !== 1 || Boolean(analysis.chains);
  for (const segment of analysis.segments) {
    const argv =
      segment.resolution?.effectiveArgv && segment.resolution.effectiveArgv.length > 0
        ? segment.resolution.effectiveArgv
        : segment.argv;
    const cliArgv = readCliArgv(argv);
    if (cliArgv) {
      const parsed = parseGatewayActionFromCliArgv(cliArgv, identityEnv);
      if (parsed) {
        return {
          action: parsed.action,
          source: "openclaw-cli",
          hard: parsed.hard,
          complex: complex || parsed.complex,
          ...(parsed.json ? { json: true } : {}),
        };
      }
    }

    const systemctlAction = parseGatewayActionFromSystemctlArgv(argv, identityEnv, platform);
    if (systemctlAction) {
      return {
        action: systemctlAction,
        source: "systemctl",
        hard: false,
        complex,
      };
    }

    const launchctlAction = parseGatewayActionFromLaunchctlArgv(argv, identityEnv, platform);
    if (launchctlAction) {
      return {
        action: launchctlAction,
        source: "launchctl",
        hard: false,
        complex,
      };
    }

    const schtasksAction = parseGatewayActionFromSchtasksArgv(argv, identityEnv, platform);
    if (schtasksAction) {
      return {
        action: schtasksAction,
        source: "schtasks",
        hard: false,
        complex,
      };
    }
  }

  return null;
}

function buildBlockedMessage(commandMatch: GatewayManagementExecCommand): string {
  if (commandMatch.action !== "restart") {
    return (
      "Gateway start/stop via exec is blocked. " +
      "Use `openclaw gateway start` / `openclaw gateway stop` instead."
    );
  }
  if (commandMatch.hard) {
    return (
      "`openclaw gateway restart --hard` via exec is blocked because it can drop tool results. " +
      "Use `gateway(action=restart)` or `/restart` instead."
    );
  }
  if (commandMatch.complex) {
    return (
      "Gateway restart command chaining/piping via exec is blocked for safety. " +
      "Run only `openclaw gateway restart` (or use the `gateway` tool)."
    );
  }
  return "Gateway management via exec is blocked.";
}

function buildCompletedResult(text: string, cwd: string): AgentToolResult<ExecToolDetails> {
  return {
    content: [{ type: "text", text }],
    details: {
      status: "completed",
      exitCode: 0,
      durationMs: 0,
      aggregated: text,
      cwd,
    },
  };
}

function buildRestartJsonResult(cwd: string): AgentToolResult<ExecToolDetails> {
  const service = resolveGatewayService();
  const payload = {
    ok: true,
    action: "restart",
    result: "restarted",
    service: {
      label: service.label,
      loaded: true,
      loadedText: service.loadedText,
      notLoadedText: service.notLoadedText,
    },
  };
  return buildCompletedResult(JSON.stringify(payload, null, 2), cwd);
}

export async function maybeInterceptGatewayManagementExec(params: {
  host: ExecHost;
  command: string;
  cwd: string;
  env: Record<string, string>;
  runtimeEnv?: NodeJS.ProcessEnv;
  requestedEnv?: Record<string, string>;
  sessionKey?: string;
  agentId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  safeBins: Set<string>;
  safeBinProfiles: Readonly<Record<string, SafeBinProfile>>;
  trustedSafeBinDirs?: ReadonlySet<string>;
}): Promise<AgentToolResult<ExecToolDetails> | null> {
  if (params.host !== "gateway") {
    return null;
  }

  const runtimeEnv = params.runtimeEnv ?? process.env;
  if (requestEnvRetargetsGatewayIdentity({ runtimeEnv, requestedEnv: params.requestedEnv })) {
    return null;
  }

  const commandMatch = detectGatewayManagementExecCommand({
    command: params.command,
    cwd: params.cwd,
    env: params.env,
    identityEnv: runtimeEnv,
  });
  if (!commandMatch) {
    return null;
  }

  if (commandMatch.action !== "restart" || commandMatch.hard || commandMatch.complex) {
    throw new Error(buildBlockedMessage(commandMatch));
  }

  // Enforce gateway exec approval policy (deny/allowlist/ask) before we schedule a
  // restart and return a completed tool result. If approval is required, we fall
  // through so the normal allowlist/approval flow can handle it.
  const { approvals, hostSecurity, hostAsk } = resolveExecHostApprovalContext({
    agentId: params.agentId,
    security: params.security,
    ask: params.ask,
    host: "gateway",
  });
  const allowlistEval = evaluateShellAllowlist({
    command: params.command,
    allowlist: approvals.allowlist,
    safeBins: params.safeBins,
    safeBinProfiles: params.safeBinProfiles,
    cwd: params.cwd,
    env: params.env,
    platform: process.platform,
    trustedSafeBinDirs: params.trustedSafeBinDirs,
  });
  const analysisOk = allowlistEval.analysisOk;
  const allowlistSatisfied =
    hostSecurity === "allowlist" && analysisOk ? allowlistEval.allowlistSatisfied : false;
  if (
    requiresExecApproval({
      ask: hostAsk,
      security: hostSecurity,
      analysisOk,
      allowlistSatisfied,
    })
  ) {
    return null;
  }
  if (hostSecurity === "allowlist" && (!analysisOk || !allowlistEval.allowlistSatisfied)) {
    throw new Error("exec denied: allowlist miss");
  }

  const cfg = loadConfig();
  if (!isRestartEnabled(cfg)) {
    throw new Error("Gateway restart is disabled (commands.restart=false).");
  }

  const sessionKey = params.sessionKey?.trim() || undefined;
  const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
  const payload: RestartSentinelPayload = {
    kind: "restart",
    status: "ok",
    ts: Date.now(),
    sessionKey,
    deliveryContext,
    threadId,
    message: "Gateway restart requested via exec command.",
    doctorHint: formatDoctorNonInteractiveHint(),
    stats: {
      mode: "gateway.restart.exec",
      reason: RESTART_REASON,
    },
  };

  try {
    await writeRestartSentinel(payload);
  } catch {
    // best-effort
  }

  const scheduled = scheduleGatewaySigusr1Restart({ reason: RESTART_REASON });
  const text =
    `Gateway restart scheduled safely (${scheduled.mode}) via internal SIGUSR1 path. ` +
    `Delay: ${scheduled.delayMs}ms.`;
  logInfo(
    `exec: intercepted gateway restart command (${commandMatch.source}, session=${sessionKey ?? "unknown"}, delayMs=${scheduled.delayMs})`,
  );
  if (commandMatch.json) {
    return buildRestartJsonResult(params.cwd);
  }
  return buildCompletedResult(text, params.cwd);
}
