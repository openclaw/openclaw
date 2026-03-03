import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { isRestartEnabled } from "../config/commands.js";
import { loadConfig } from "../config/config.js";
import { extractDeliveryInfo } from "../config/sessions/delivery-info.js";
import {
  LEGACY_GATEWAY_WINDOWS_TASK_NAMES,
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../daemon/constants.js";
import { analyzeShellCommand } from "../infra/exec-approvals-analysis.js";
import type { ExecHost } from "../infra/exec-approvals.js";
import { normalizeExecutableToken } from "../infra/exec-wrapper-resolution.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../infra/restart.js";
import { logInfo } from "../logger.js";
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
const PNPM_OPTIONS_WITH_VALUE = new Set(["-c", "--dir", "-f", "--filter"]);
const PNPM_EXEC_OPTIONS_WITH_VALUE = new Set(["--package"]);
const SYSTEMCTL_OPTIONS_WITH_VALUE = new Set([
  "-H",
  "--host",
  "-M",
  "--machine",
  "-n",
  "--lines",
  "-o",
  "--output",
  "--output-fields",
  "-p",
  "--property",
  "-t",
  "--type",
  "--root",
  "--state",
  "--kill-whom",
  "--signal",
  "--job-mode",
  "--when",
]);

export type GatewayManagementExecSource = "openclaw-cli" | "systemctl" | "launchctl" | "schtasks";

export type GatewayManagementAction = "restart" | "start" | "stop";

export type GatewayManagementExecCommand = {
  action: GatewayManagementAction;
  source: GatewayManagementExecSource;
  hard: boolean;
  complex: boolean;
};

function normalizeLower(token: string | undefined): string {
  return token?.trim().toLowerCase() ?? "";
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

function normalizeSystemdUnitToken(token: string): string {
  const base = basenameLower(token);
  return base.endsWith(".service") ? base.slice(0, -".service".length) : base;
}

function collectGatewaySystemdUnitBases(env: NodeJS.ProcessEnv): Set<string> {
  const units = new Set<string>();
  units.add(resolveGatewaySystemdServiceName().toLowerCase());
  units.add(resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE).toLowerCase());
  for (const legacy of LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES) {
    units.add(legacy.toLowerCase());
  }

  const configured = normalizeSystemdUnitToken(env.OPENCLAW_SYSTEMD_UNIT ?? "");
  if (configured) {
    units.add(configured);
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
  labels.add(resolveGatewayLaunchAgentLabel().toLowerCase());
  labels.add(resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE).toLowerCase());

  const configured = normalizeLower(env.OPENCLAW_LAUNCHD_LABEL);
  if (configured) {
    labels.add(configured);
  }

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
  names.add(resolveGatewayWindowsTaskName().toLowerCase());
  names.add(resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE).toLowerCase());
  for (const legacy of LEGACY_GATEWAY_WINDOWS_TASK_NAMES) {
    names.add(legacy.toLowerCase());
  }

  const configured = normalizeLower(env.OPENCLAW_WINDOWS_TASK_NAME);
  if (configured) {
    names.add(configured);
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

function readPnpmCliArgv(argv: string[]): string[] | null {
  const second = argv[1]?.trim();
  if (second && normalizeExecutableToken(second) === "openclaw") {
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
      const lower = token.toLowerCase();
      const [flag] = lower.split("=", 2);
      if (!lower.includes("=") && PNPM_OPTIONS_WITH_VALUE.has(flag) && idx + 1 < argv.length) {
        idx += 2;
        continue;
      }
      idx += 1;
      continue;
    }
    break;
  }

  if (idx >= argv.length) {
    return null;
  }

  const commandToken = argv[idx]?.trim() ?? "";
  if (normalizeExecutableToken(commandToken) === "openclaw") {
    return argv.slice(idx + 1);
  }
  if (normalizeLower(commandToken) !== "exec") {
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
      const lower = token.toLowerCase();
      const [flag] = lower.split("=", 2);
      if (!lower.includes("=") && PNPM_EXEC_OPTIONS_WITH_VALUE.has(flag) && idx + 1 < argv.length) {
        idx += 2;
        continue;
      }
      idx += 1;
      continue;
    }
    break;
  }

  if (idx < argv.length && normalizeExecutableToken(argv[idx]) === "openclaw") {
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
        idx += 1;
        continue;
      }
      break;
    }
    if (idx < argv.length && normalizeExecutableToken(argv[idx]) === "openclaw") {
      return argv.slice(idx + 1);
    }
    return null;
  }

  if (first === "npm") {
    if ((argv[1]?.trim() ?? "").toLowerCase() !== "exec") {
      return null;
    }
    let idx = 2;
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
        idx += 1;
        continue;
      }
      break;
    }
    if (idx < argv.length && normalizeExecutableToken(argv[idx]) === "openclaw") {
      return argv.slice(idx + 1);
    }
  }

  return null;
}

function parseGatewayActionFromCliArgv(cliArgv: string[]): {
  action: GatewayManagementAction;
  hard: boolean;
} | null {
  if (cliArgv.length < 2) {
    return null;
  }

  const gatewayIdx = cliArgv.findIndex((token) => token.trim().toLowerCase() === "gateway");
  if (gatewayIdx < 0 || gatewayIdx + 1 >= cliArgv.length) {
    return null;
  }

  const actionRaw = cliArgv[gatewayIdx + 1]?.trim().toLowerCase();
  if (actionRaw !== "restart" && actionRaw !== "start" && actionRaw !== "stop") {
    return null;
  }

  const trailing = new Set(
    cliArgv.slice(gatewayIdx + 2).map((token) => token.trim().toLowerCase()),
  );
  if (trailing.has("--help") || trailing.has("-h")) {
    return null;
  }
  const hard = actionRaw === "restart" && trailing.has("--hard");
  return { action: actionRaw, hard };
}

function collectSystemctlPositionals(argv: string[]): string[] {
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
    const lower = token.toLowerCase();
    const [flag] = lower.split("=", 2);
    if (!lower.includes("=") && SYSTEMCTL_OPTIONS_WITH_VALUE.has(flag) && idx + 1 < argv.length) {
      idx += 1;
    }
  }
  return positionals;
}

function parseGatewayActionFromSystemctlArgv(
  argv: string[],
  env: NodeJS.ProcessEnv,
): GatewayManagementAction | null {
  if (normalizeExecutableToken(argv[0] ?? "") !== "systemctl") {
    return null;
  }
  if (hasSystemctlRemoteScope(argv)) {
    return null;
  }

  const positionals = collectSystemctlPositionals(argv);
  if (positionals.length < 2) {
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
): GatewayManagementAction | null {
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
): GatewayManagementAction | null {
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

export function detectGatewayManagementExecCommand(params: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): GatewayManagementExecCommand | null {
  const analysis = analyzeShellCommand({
    command: params.command,
    cwd: params.cwd,
    env: params.env,
    platform: process.platform,
  });
  if (!analysis.ok || analysis.segments.length === 0) {
    return null;
  }

  const complex = analysis.segments.length !== 1 || Boolean(analysis.chains);
  for (const segment of analysis.segments) {
    const argv =
      segment.resolution?.effectiveArgv && segment.resolution.effectiveArgv.length > 0
        ? segment.resolution.effectiveArgv
        : segment.argv;
    const cliArgv = readCliArgv(argv);
    if (cliArgv) {
      const parsed = parseGatewayActionFromCliArgv(cliArgv);
      if (parsed) {
        return {
          action: parsed.action,
          source: "openclaw-cli",
          hard: parsed.hard,
          complex,
        };
      }
    }

    const systemctlAction = parseGatewayActionFromSystemctlArgv(argv, params.env);
    if (systemctlAction) {
      return {
        action: systemctlAction,
        source: "systemctl",
        hard: false,
        complex,
      };
    }

    const launchctlAction = parseGatewayActionFromLaunchctlArgv(argv, params.env);
    if (launchctlAction) {
      return {
        action: launchctlAction,
        source: "launchctl",
        hard: false,
        complex,
      };
    }

    const schtasksAction = parseGatewayActionFromSchtasksArgv(argv, params.env);
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
      "Use the `gateway` tool or `/restart` so restart coordination and delivery state stay consistent."
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

export async function maybeInterceptGatewayManagementExec(params: {
  host: ExecHost;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionKey?: string;
}): Promise<AgentToolResult<ExecToolDetails> | null> {
  if (params.host !== "gateway") {
    return null;
  }

  const commandMatch = detectGatewayManagementExecCommand({
    command: params.command,
    cwd: params.cwd,
    env: params.env,
  });
  if (!commandMatch) {
    return null;
  }

  if (commandMatch.action !== "restart" || commandMatch.hard || commandMatch.complex) {
    throw new Error(buildBlockedMessage(commandMatch));
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
  return buildCompletedResult(text, params.cwd);
}
