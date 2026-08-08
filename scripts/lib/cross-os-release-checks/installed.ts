import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import {
  agentOutputHasExpectedOkMarker,
  buildCrossOsReleaseAgentSessionId,
  buildReleaseAgentTurnArgs,
  maybeBuildOptionalAgentTurnSkipResult,
  shouldRetryCrossOsAgentTurnError,
} from "./agent.ts";
import type {
  AgentTurnResult,
  CommandOptions,
  GatewayHandle,
  LaneState,
  ProviderConfig,
} from "./config.ts";
import {
  CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS,
  CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
  CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS,
  CROSS_OS_MANAGED_GATEWAY_DIAGNOSTIC_TAIL_BYTES,
  CROSS_OS_RELEASE_SMOKE_TOOLS_PROFILE,
  buildCrossOsReleaseSmokeMemorySlotConfigArgs,
  buildCrossOsReleaseSmokePluginAllowlist,
  buildReleaseProviderConfigOverride,
  gatewayReadyDeadlineMs,
  installTimeoutMs,
  looksLikeCommitSha,
  resolveExplicitBaselineVersion,
  resolveExpectedDevUpdateRef,
  shouldSkipInstallerDaemonHealthCheck,
} from "./config.ts";
import {
  installedEntryPath,
  normalizeWindowsInstalledCliPath,
  npmCommand,
  resolveInstalledPrefixDirFromCliPath,
} from "./install.ts";
import {
  readLogFileSize,
  readLogTextSince,
  writePrivateDiagnosticText,
  writeRedactedLogTail,
} from "./logs.ts";
import {
  canConnectToLoopbackPort,
  hasChildExited,
  resolveCommandSpawnInvocation,
  runCommand,
  runCommandInvocation,
  waitForGatewayWithStartupMigrationRestart,
  withAllocatedGatewayPort,
} from "./process.ts";
import { formatError, shellEscapeForSh, sleep } from "./shared.ts";

const INSTALLER_CONNECT_TIMEOUT_SECONDS = 10;
const INSTALLER_REQUEST_TIMEOUT_SECONDS = 120;
const SENSITIVE_ENV_NAME_RE =
  /(?:^|_)(?:AUTH|COOKIE|CREDENTIAL|JWT|KEY|PASS(?:WORD|WD)?|SECRET|SESSION|SIGNATURE|TOKEN)(?:_|$)/iu;
const SENSITIVE_CREDENTIAL_KEY_SOURCE = String.raw`(?:(?:[A-Z0-9]+[_-])*(?:AUTH(?:ORIZATION)?|COOKIE|CREDENTIAL|JWT|KEY|PASS(?:WORD|WD|PHRASE)?|SECRET|SESSION|SIGNATURE|TOKEN)|api[-_]?key|api[-_]?token|bearer[-_]?token|private[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|client[-_]?secret|app[-_]?secret|secret[-_]?(?:value|input)|raw[-_]?secret|key[-_]?material|aws[-_]?secret[-_]?access[-_]?key|set[-_]?cookie)`;
const SENSITIVE_CREDENTIAL_ASSIGNMENT_RE = new RegExp(
  String.raw`(["']?\b${SENSITIVE_CREDENTIAL_KEY_SOURCE}\b["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,;)}\]\r\n]+)`,
  "giu",
);
const SENSITIVE_URL_QUERY_RE = new RegExp(
  String.raw`([?&]${SENSITIVE_CREDENTIAL_KEY_SOURCE}=)[^&#\s<>]*`,
  "giu",
);
const URL_USERINFO_PASSWORD_RE = /(\b[a-z][a-z0-9+.-]*:(?:\/\/|\\\/\\\/)[^/\s:@]*:)[^/\s@]+(@)/giu;

type ManagedGatewayDiagnosticPhase = "initial" | "fallback-start";

// The release harness runs directly with bare Node before workspace packages exist.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceLiteral(
  value: string,
  literal: string,
  replacement: string,
  options: { caseInsensitive?: boolean } = {},
) {
  if (!literal) {
    return value;
  }
  if (!options.caseInsensitive) {
    return value.replaceAll(literal, replacement);
  }
  return value.replace(new RegExp(escapeRegExp(literal), "giu"), () => replacement);
}

function redactCredentialText(value: string) {
  return value
    .replace(URL_USERINFO_PASSWORD_RE, "$1***$2")
    .replace(SENSITIVE_URL_QUERY_RE, "$1***")
    .replace(SENSITIVE_CREDENTIAL_ASSIGNMENT_RE, (_match, prefix: string, credential: string) => {
      const quote = credential[0];
      return quote === '"' || quote === "'" || quote === "`"
        ? `${prefix}${quote}***${quote}`
        : `${prefix}***`;
    });
}

function redactManagedGatewayDiagnosticText(params: {
  text: string;
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  managedStateDir?: string;
}) {
  let redacted = params.text;
  const sensitiveValues = Object.entries(params.env)
    .filter(([key, value]) => SENSITIVE_ENV_NAME_RE.test(key) && Boolean(value))
    .map(([, value]) => value as string)
    .toSorted((a, b) => b.length - a.length);
  for (const value of sensitiveValues) {
    redacted = replaceLiteral(redacted, value, "***");
  }

  const pathReplacements: Array<[string | undefined, string]> = [
    [params.managedStateDir, "[MANAGED_STATE_DIR]"],
    [params.lane.stateDir, "[STATE_DIR]"],
    [params.lane.appDataDir, "[APPDATA_DIR]"],
    [params.lane.homeDir, "[HOME]"],
    [params.lane.rootDir, "[LANE_ROOT]"],
    [params.env.LOCALAPPDATA, "[LOCALAPPDATA]"],
    [params.env.TEMP, "[TEMP]"],
    [params.env.TMP, "[TEMP]"],
    [params.env.TMPDIR, "[TEMP]"],
    [params.env.USERPROFILE, "[HOME]"],
    [params.env.HOME, "[HOME]"],
  ];
  for (const [pathValue, replacement] of pathReplacements
    .filter(([value]) => Boolean(value))
    .toSorted((a, b) => (b[0]?.length ?? 0) - (a[0]?.length ?? 0))) {
    if (!pathValue) {
      continue;
    }
    const slashNormalized = pathValue.replaceAll("\\", "/");
    const variants = new Set([
      pathValue,
      slashNormalized,
      JSON.stringify(pathValue).slice(1, -1),
      JSON.stringify(slashNormalized).slice(1, -1),
    ]);
    for (const variant of variants) {
      redacted = replaceLiteral(redacted, variant, replacement, { caseInsensitive: true });
    }
  }
  return redactCredentialText(redacted);
}

function readString(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function resolveManagedGatewayStateDir(payload: unknown, env: NodeJS.ProcessEnv) {
  const root = isRecord(payload) ? payload : {};
  const service = isRecord(root.service) ? root.service : {};
  const command = isRecord(service.command) ? service.command : {};
  const environment = isRecord(command.environment) ? command.environment : {};
  const configuredStateDir = readString(environment, "OPENCLAW_STATE_DIR")?.trim();
  if (configuredStateDir) {
    return configuredStateDir;
  }
  const homeDir = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!homeDir) {
    return undefined;
  }
  const profile = readString(environment, "OPENCLAW_PROFILE")?.trim();
  const suffix = profile && profile.toLowerCase() !== "default" ? `-${profile}` : "";
  return join(homeDir, `.openclaw${suffix}`);
}

function buildManagedGatewayDiagnosticStatus(payload: unknown, redact: (text: string) => string) {
  const root = isRecord(payload) ? payload : {};
  const service = isRecord(root.service) ? root.service : {};
  const runtime = isRecord(service.runtime) ? service.runtime : {};
  const status: Record<string, string | number> = {};
  for (const key of ["status", "state", "lastRunTime", "lastRunResult"] as const) {
    const value = readString(runtime, key);
    if (value !== undefined) {
      status[key] = value;
    }
  }
  if (typeof runtime.pid === "number" && Number.isSafeInteger(runtime.pid)) {
    status.pid = runtime.pid;
  }
  const detail = readString(runtime, "detail");
  if (detail !== undefined) {
    status.detail = redact(detail);
  }

  const driftReport = isRecord(root.pluginVersionDrift) ? root.pluginVersionDrift : {};
  const reportExpected = readString(driftReport, "gatewayVersion");
  const drifts = Array.isArray(driftReport.drifts)
    ? driftReport.drifts.flatMap((value) => {
        if (!isRecord(value)) {
          return [];
        }
        const entry = {
          id: readString(value, "pluginId"),
          installed: readString(value, "installedVersion"),
          source: readString(value, "source"),
          expected: readString(value, "gatewayVersion") ?? reportExpected,
        };
        return [
          Object.fromEntries(Object.entries(entry).filter(([, field]) => field !== undefined)),
        ];
      })
    : [];

  return {
    ...(Object.keys(status).length > 0 ? { service: status } : {}),
    ...(drifts.length > 0 ? { pluginVersionDrift: drifts } : {}),
  };
}

function managedGatewayDiagnosticDir(logPath: string) {
  const extension = extname(logPath);
  const stem = basename(logPath, extension);
  return join(dirname(logPath), `${stem}-diagnostics`);
}

export async function resolveInstallerTargetVersion(params: {
  baselineSpec: string;
  logsDir: string;
  suiteName: string;
}) {
  const resolvedVersion = resolveExplicitBaselineVersion(params.baselineSpec);
  if (resolvedVersion) {
    return resolvedVersion;
  }
  const latestResult = await runCommand(npmCommand(), ["view", "openclaw@latest", "version"], {
    logPath: join(params.logsDir, `${params.suiteName}-latest-version.log`),
    timeoutMs: 2 * 60 * 1000,
  });
  const latestVersion = latestResult.stdout.trim();
  if (!latestVersion) {
    throw new Error("npm view openclaw@latest version did not return a version.");
  }
  return latestVersion;
}

function powerShellSingleQuote(value: string) {
  return value.replace(/'/gu, "''");
}

function parseMarkerLine(output: string, marker: string) {
  return output
    .split(/\r?\n/gu)
    .find((line) => line.startsWith(marker))
    ?.slice(marker.length)
    .trim();
}

export function resolveInstalledCliInvocation(
  cliPath: string,
  args: string[] = [],
  options: { platform?: NodeJS.Platform; comSpec?: string; env?: NodeJS.ProcessEnv } = {
    platform: process.platform,
  },
) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command: cliPath, args, shell: false };
  }
  const normalizedCliPath = normalizeWindowsInstalledCliPath(cliPath);
  if (!/\.cmd$/iu.test(normalizedCliPath)) {
    return { command: normalizedCliPath, args, shell: false };
  }
  const entryPath = installedEntryPath(
    resolveInstalledPrefixDirFromCliPath(normalizedCliPath, platform),
  );
  if (existsSync(entryPath)) {
    return {
      command: process.execPath,
      args: [entryPath, ...args],
      shell: false,
    };
  }
  return resolveCommandSpawnInvocation(normalizedCliPath, args, {
    comSpec: options.comSpec,
    env: options.env,
    platform,
  });
}

async function runPosixShellScript(script: string, options: CommandOptions) {
  return runCommand("/bin/bash", ["-lc", script], options);
}

async function runPowerShellScript(script: string, options: CommandOptions) {
  return runCommand(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    options,
  );
}

export function buildInstallerSmokeScript(
  params: {
    installerUrl: string;
    installTarget: string;
    platform?: NodeJS.Platform;
  },
  options: {
    connectTimeoutSeconds?: number;
    requestTimeoutSeconds?: number;
  } = {},
) {
  const connectTimeoutSeconds = options.connectTimeoutSeconds ?? INSTALLER_CONNECT_TIMEOUT_SECONDS;
  const requestTimeoutSeconds = options.requestTimeoutSeconds ?? INSTALLER_REQUEST_TIMEOUT_SECONDS;
  if ((params.platform ?? process.platform) === "win32") {
    return `
$installerPath = Join-Path ([System.IO.Path]::GetTempPath()) ("openclaw-installer-" + [guid]::NewGuid().ToString("N") + ".ps1")
try {
  & curl.exe -fsSL --connect-timeout ${connectTimeoutSeconds} --max-time ${requestTimeoutSeconds} -o $installerPath '${powerShellSingleQuote(params.installerUrl)}'
  if ($LASTEXITCODE -ne 0) {
    throw "curl.exe failed to download the OpenClaw installer (exit $LASTEXITCODE)"
  }
  $content = [System.IO.File]::ReadAllText($installerPath, [System.Text.Encoding]::UTF8)
  & ([scriptblock]::Create($content)) -Tag '${powerShellSingleQuote(params.installTarget)}' -NoOnboard
} finally {
  Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
}
`;
  }

  // Execute only a complete installer: a timed-out response may still contain an executable prefix.
  return [
    "set -euo pipefail",
    'installer_path="$(mktemp "${TMPDIR:-/tmp}/openclaw-installer-XXXXXX")"',
    "trap 'rm -f \"$installer_path\"' EXIT",
    `curl -fsSL --connect-timeout ${connectTimeoutSeconds} --max-time ${requestTimeoutSeconds} -o "$installer_path" '${shellEscapeForSh(params.installerUrl)}'`,
    `bash -- "$installer_path" --version '${shellEscapeForSh(params.installTarget)}' --no-onboard`,
  ].join("\n");
}

export async function runInstallerSmoke(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  installerUrl: string;
  installTarget: string;
  logPath: string;
}) {
  const script = buildInstallerSmokeScript(params);
  if (process.platform === "win32") {
    await runPowerShellScript(script, {
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: installTimeoutMs(),
    });
    return;
  }

  await runPosixShellScript(script, {
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: installTimeoutMs(),
  });
}

export function buildWindowsPathBootstrapScript(
  options: { includeCurrentProcessPath?: boolean } = {},
) {
  const includeCurrentProcessPath = options.includeCurrentProcessPath !== false;
  // setup-node provisions the supported runtime in the current process PATH. Keep it ahead of
  // stale runner image entries while still merging newly persisted user and machine paths.
  const pathCandidates = includeCurrentProcessPath
    ? "@($env:Path, $userPath, $machinePath)"
    : "@($userPath, $machinePath)";
  return `
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$segments = New-Object System.Collections.Generic.List[string]
foreach ($candidate in ${pathCandidates}) {
  foreach ($segment in ($candidate -split ';')) {
    if ([string]::IsNullOrWhiteSpace($segment)) {
      continue
    }
    if (-not $segments.Contains($segment)) {
      $segments.Add($segment)
    }
  }
}
$env:Path = [string]::Join(';', $segments)
`.trim();
}

export function buildWindowsFreshShellVersionCheckScript(params: { expectedNeedle?: string } = {}) {
  const expectedNeedle = powerShellSingleQuote(params.expectedNeedle ?? "");
  return `
${buildWindowsPathBootstrapScript()}
$commandPath = $null
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) {
  $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
}
if ($null -ne $npmCommand) {
  $npmPrefix = (& $npmCommand.Source config get prefix 2>$null | Out-String).Trim()
  if (-not [string]::IsNullOrWhiteSpace($npmPrefix)) {
    $env:Path = "$npmPrefix;$env:Path"
    foreach ($candidate in @(
      (Join-Path $npmPrefix 'openclaw.cmd'),
      (Join-Path $npmPrefix 'openclaw.ps1')
    )) {
      if (Test-Path -LiteralPath $candidate) {
        $commandPath = $candidate
        break
      }
    }
  }
}
if ([string]::IsNullOrWhiteSpace($commandPath)) {
  $cmd = Get-Command openclaw -ErrorAction Stop
  $commandPath = $cmd.Source
}
if ($commandPath -match '(?i)\\.ps1$') {
  $cmdPath = [System.IO.Path]::ChangeExtension($commandPath, '.cmd')
  if (Test-Path -LiteralPath $cmdPath) {
    $commandPath = $cmdPath
  }
}
$version = (& $commandPath --version 2>&1 | Out-String).Trim()
Write-Output "__OPENCLAW_PATH__=$commandPath"
Write-Output $version
if ('${expectedNeedle}'.Length -gt 0 -and $version -notmatch [regex]::Escape('${expectedNeedle}')) {
  throw "version mismatch: expected substring ${expectedNeedle}"
}
`.trim();
}

export function buildWindowsDevUpdateToolchainCheckScript() {
  return `
${buildWindowsPathBootstrapScript()}
function Resolve-CommandPath([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    return $null
  }
  $commandPath = $command.Source
  if ($commandPath -match '(?i)\\.ps1$') {
    $cmdPath = [System.IO.Path]::ChangeExtension($commandPath, '.cmd')
    if (Test-Path -LiteralPath $cmdPath) {
      $commandPath = $cmdPath
    }
  }
  return $commandPath
}
$pnpmPath = Resolve-CommandPath 'pnpm'
if ($null -ne $pnpmPath) {
  Write-Output "__UPDATE_TOOL__=pnpm"
  Write-Output "__UPDATE_TOOL_PATH__=$pnpmPath"
  & $pnpmPath --version
  return
}
$corepackPath = Resolve-CommandPath 'corepack'
if ($null -ne $corepackPath) {
  Write-Output "__UPDATE_TOOL__=corepack"
  Write-Output "__UPDATE_TOOL_PATH__=$corepackPath"
  & $corepackPath --version
  return
}
$npmPath = Resolve-CommandPath 'npm'
if ($null -ne $npmPath) {
  Write-Output "__UPDATE_TOOL__=npm"
  Write-Output "__UPDATE_TOOL_PATH__=$npmPath"
  & $npmPath --version
  return
}
throw 'Neither pnpm, corepack, nor npm is discoverable from the reconstructed Windows PATH.'
`.trim();
}

export async function verifyFreshShellCommand(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  expectedNeedle: string;
  logPath: string;
}) {
  if (process.platform === "win32") {
    const script = buildWindowsFreshShellVersionCheckScript({
      expectedNeedle: params.expectedNeedle,
    });
    const result = await runPowerShellScript(script, {
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 2 * 60 * 1000,
    });
    const cliPath = normalizeWindowsInstalledCliPath(
      parseMarkerLine(result.stdout, "__OPENCLAW_PATH__=") ?? "",
    );
    if (!cliPath) {
      throw new Error("Failed to resolve installed openclaw path from fresh Windows shell.");
    }
    return {
      cliPath,
      versionOutput: `${result.stdout}\n${result.stderr}`.trim(),
    };
  }

  const script = [
    "set -euo pipefail",
    'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
    "command -v openclaw >/dev/null 2>&1",
    'printf "__OPENCLAW_PATH__=%s\\n" "$(command -v openclaw)"',
    "openclaw --version",
  ].join("\n");
  const result = await runPosixShellScript(script, {
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  const cliPath = parseMarkerLine(result.stdout, "__OPENCLAW_PATH__=");
  const versionOutput = `${result.stdout}\n${result.stderr}`.trim();
  if (!cliPath) {
    throw new Error("Failed to resolve installed openclaw path from fresh POSIX shell.");
  }
  if (params.expectedNeedle && !versionOutput.includes(params.expectedNeedle)) {
    throw new Error(
      `Installed CLI version did not contain expected substring ${params.expectedNeedle}.`,
    );
  }
  return { cliPath, versionOutput };
}

export async function runInstalledCli(params: {
  cliPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  timeoutMs?: number;
  check?: boolean;
}) {
  const invocation = resolveInstalledCliInvocation(params.cliPath, params.args, {
    env: params.env,
    platform: process.platform,
  });
  return runCommandInvocation(invocation, {
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: params.timeoutMs,
    check: params.check ?? true,
  });
}

export async function resolveInstalledGatewayStopArgs(params: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  const help = await runInstalledCli({
    cliPath: params.cliPath,
    args: ["gateway", "stop", "--help"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 15_000,
  });
  return buildGatewayStopArgsFromHelpText(`${help.stdout}\n${help.stderr}`);
}

async function readInstalledUpdateStatus(params: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  return runInstalledCli({
    cliPath: params.cliPath,
    args: ["update", "status", "--json"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
}

export async function ensureDevUpdateGitInstall(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  cliPath: string;
  logsDir: string;
  requestedRef: string;
}) {
  const updateStatus = await readInstalledUpdateStatus({
    cliPath: params.cliPath,
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: join(params.logsDir, "dev-update-status.log"),
  });
  // The dev-update lane must prove that `openclaw update --channel dev` landed on
  // the expected git checkout. Falling back to a manual repair here would hide
  // updater regressions and turn the suite into a false green.
  verifyDevUpdateStatus(updateStatus.stdout, { ref: params.requestedRef });
  return { cliPath: params.cliPath };
}

export async function runOnboardWithInstalledCli(params: {
  lane: LaneState;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  providerConfig: ProviderConfig;
  installDaemon: boolean;
  logPath: string;
  allocateGatewayPort?: boolean;
}) {
  const runOnboard = async () => {
    const args = buildReleaseOnboardArgs({
      authChoice: params.providerConfig.authChoice,
      gatewayPort: params.lane.gatewayPort,
      installDaemon: params.installDaemon,
      skipHealth: !params.installDaemon || shouldSkipInstallerDaemonHealthCheck(),
    });
    await runInstalledCli({
      cliPath: params.cliPath,
      args,
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 10 * 60 * 1000,
    });
  };
  if (params.allocateGatewayPort === false) {
    if (params.lane.gatewayPort <= 0) {
      throw new Error("Installed onboarding requires a reserved gateway port.");
    }
    await runOnboard();
    return;
  }
  await withAllocatedGatewayPort(params.lane, runOnboard);
}

export function buildReleaseOnboardArgs(params: {
  authChoice: string;
  gatewayPort: number;
  installDaemon?: boolean;
  skipHealth?: boolean;
}) {
  const args: string[] = [
    "onboard",
    "--non-interactive",
    "--mode",
    "local",
    "--auth-choice",
    params.authChoice,
    "--secret-input-mode",
    "ref",
    "--gateway-port",
    String(params.gatewayPort),
    "--gateway-bind",
    "loopback",
    "--skip-skills",
    "--skip-bootstrap",
    "--accept-risk",
    "--json",
  ];
  if (params.installDaemon) {
    args.push("--install-daemon");
  }
  if (params.skipHealth) {
    args.push("--skip-health");
  }
  return args;
}

export async function startManualGatewayFromInstalledCli(params: {
  lane: LaneState;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}): Promise<GatewayHandle> {
  mkdirSync(dirname(params.logPath), { recursive: true });
  const launchLogOffset = readLogFileSize(params.logPath);
  const gatewayLog = createWriteStream(params.logPath, { flags: "a" });
  const invocation = resolveInstalledCliInvocation(
    params.cliPath,
    ["gateway", "run", "--bind", "loopback", "--port", String(params.lane.gatewayPort), "--force"],
    {
      env: params.env,
      platform: process.platform,
    },
  );
  const child = spawn(invocation.command, invocation.args, {
    cwd: params.lane.homeDir,
    env: params.env,
    shell: invocation.shell,
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk) => {
    gatewayLog.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    gatewayLog.write(chunk);
  });
  let resolveChildClose: () => void;
  const childClosePromise = new Promise<void>((resolvePromise) => {
    resolveChildClose = resolvePromise;
  });
  let closeLogPromise: Promise<void> | undefined;
  const closeLog = () => {
    closeLogPromise ??= new Promise<void>((resolvePromise) => {
      gatewayLog.once("error", () => resolvePromise());
      gatewayLog.end(() => resolvePromise());
    });
    return closeLogPromise;
  };
  child.once("close", () => {
    resolveChildClose();
    void closeLog();
  });
  child.once("error", () => {
    resolveChildClose();
    void closeLog();
  });
  return {
    child,
    closeLog,
    launchLogOffset,
    logPath: params.logPath,
    waitForClose: () => childClosePromise,
  };
}

async function resolveInstalledGatewayStatusArgs(params: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  requireRpc?: boolean;
}) {
  const requireRpc = params.requireRpc !== false;
  try {
    const help = await runInstalledCli({
      cliPath: params.cliPath,
      args: ["gateway", "status", "--help"],
      cwd: params.cwd,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 15_000,
      check: false,
    });
    return buildGatewayStatusArgsFromHelpText(`${help.stdout}\n${help.stderr}`, { requireRpc });
  } catch (error) {
    appendGatewayStatusHelpProbeFallback(params.logPath, error);
    return buildGatewayStatusArgsFromHelpText("--require-rpc", { requireRpc });
  }
}

export function buildGatewayStatusArgsFromHelpText(
  helpText: string,
  options: { requireRpc?: boolean } = {},
) {
  const requireRpc = options.requireRpc !== false;
  if (requireRpc && helpText.includes("--require-rpc")) {
    return [
      "gateway",
      "status",
      "--require-rpc",
      "--timeout",
      String(CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS),
    ];
  }
  return ["gateway", "status"];
}

export function buildGatewayStopArgsFromHelpText(helpText: string) {
  if (helpText.includes("--force")) {
    return ["gateway", "stop", "--force"];
  }
  return ["gateway", "stop"];
}

export function appendGatewayStatusHelpProbeFallback(logPath: string, error: unknown) {
  appendFileSync(
    logPath,
    `${new Date().toISOString()} gateway status help probe failed; assuming current --require-rpc support: ${formatError(error)}\n`,
  );
}

export async function waitForInstalledGateway(params: {
  lane: LaneState;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  gateway?: GatewayHandle;
  gatewayHolder?: { current: GatewayHandle | null };
  gatewayLogPath?: string;
  logPath: string;
}) {
  if (params.gatewayHolder) {
    if (!params.gatewayLogPath) {
      throw new Error("Gateway restart coordination requires a gateway log path.");
    }
    const gatewayLogPath = params.gatewayLogPath;
    await waitForGatewayWithStartupMigrationRestart({
      gatewayHolder: params.gatewayHolder,
      restartGateway: () =>
        startManualGatewayFromInstalledCli({
          lane: params.lane,
          cliPath: params.cliPath,
          env: params.env,
          logPath: gatewayLogPath,
        }),
      waitUntilReady: (gateway) =>
        waitForInstalledGateway({
          lane: params.lane,
          cliPath: params.cliPath,
          env: params.env,
          gateway,
          logPath: params.logPath,
        }),
    });
    return;
  }

  const statusArgs = await resolveInstalledGatewayStatusArgs({
    cliPath: params.cliPath,
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
  });
  const deadline = Date.now() + gatewayReadyDeadlineMs();
  while (Date.now() < deadline) {
    if (params.gateway && hasChildExited(params.gateway.child)) {
      throw new Error(`Gateway exited before becoming ready on port ${params.lane.gatewayPort}.`);
    }
    const result = await runInstalledCli({
      cliPath: params.cliPath,
      args: statusArgs,
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
      check: false,
    });
    if (result.exitCode === 0) {
      return;
    }
    if (params.gateway && hasChildExited(params.gateway.child)) {
      throw new Error(`Gateway exited before becoming ready on port ${params.lane.gatewayPort}.`);
    }
    await sleep(2_000);
  }
  throw new Error(`Gateway did not become ready on port ${params.lane.gatewayPort}.`);
}

export async function waitForInstalledGatewayToStop(params: {
  lane: LaneState;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  const statusArgs = await resolveInstalledGatewayStatusArgs({
    cliPath: params.cliPath,
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    requireRpc: false,
  });
  const deadline = Date.now() + gatewayReadyDeadlineMs();
  while (Date.now() < deadline) {
    await runInstalledCli({
      cliPath: params.cliPath,
      args: statusArgs,
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
      check: false,
    });
    const portReachable = await canConnectToLoopbackPort(params.lane.gatewayPort);
    if (!portReachable) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(
    `Managed gateway did not stop on port ${params.lane.gatewayPort} before manual fallback.`,
  );
}

export async function collectManagedGatewayReadinessDiagnostics(
  params: {
    lane: LaneState;
    cliPath: string;
    env: NodeJS.ProcessEnv;
    logPath: string;
    phase: ManagedGatewayDiagnosticPhase;
  },
  options: { runStatus?: typeof runInstalledCli } = {},
) {
  try {
    const outputDir = managedGatewayDiagnosticDir(params.logPath);
    let statusPayload: unknown;
    let rawDir: string | undefined;
    try {
      rawDir = mkdtempSync(join(params.lane.rootDir, ".managed-gateway-readiness-"));
      chmodSync(rawDir, 0o700);
      const rawStatusPath = join(rawDir, "gateway-status.raw.log");
      writePrivateDiagnosticText(rawStatusPath, "");
      const result = await (options.runStatus ?? runInstalledCli)({
        cliPath: params.cliPath,
        args: ["gateway", "status", "--json", "--no-probe"],
        cwd: params.lane.homeDir,
        env: params.env,
        logPath: rawStatusPath,
        timeoutMs: CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
        check: false,
      });
      statusPayload = JSON.parse(result.stdout) as unknown;
    } catch {
      // Status collection is diagnostic only; retain any available log tails below.
    } finally {
      if (rawDir) {
        try {
          rmSync(rawDir, { recursive: true, force: true });
        } catch {
          // The lane root is ephemeral; cleanup failure must not hide readiness evidence.
        }
      }
    }
    const managedStateDir = resolveManagedGatewayStateDir(statusPayload, params.env);
    const managedLogDir = managedStateDir ? join(managedStateDir, "logs") : undefined;
    const redact = (text: string) =>
      redactManagedGatewayDiagnosticText({
        text,
        lane: params.lane,
        env: params.env,
        managedStateDir,
      });

    if (statusPayload !== undefined) {
      try {
        const sanitizedStatus = buildManagedGatewayDiagnosticStatus(statusPayload, redact);
        writePrivateDiagnosticText(
          join(outputDir, `${params.phase}-status.json`),
          `${JSON.stringify(sanitizedStatus, null, 2)}\n`,
        );
      } catch {
        // One diagnostic artifact must not prevent collection of the remaining tails.
      }
    }

    if (managedLogDir) {
      try {
        writeRedactedLogTail({
          sourcePath: join(managedLogDir, "gateway-restart.log"),
          destinationPath: join(outputDir, `${params.phase}-gateway-restart.log`),
          redact,
          maxBytes: CROSS_OS_MANAGED_GATEWAY_DIAGNOSTIC_TAIL_BYTES,
        });
      } catch {
        // Restart logging is best-effort and may not exist on an early startup failure.
      }
    }
  } catch {
    // Readiness diagnostics must never replace the managed gateway failure.
  }
}

export async function ensureManagedGatewayReady(
  params: {
    lane: LaneState;
    cliPath: string;
    env: NodeJS.ProcessEnv;
    logPath: string;
  },
  options: {
    waitForGateway?: typeof waitForInstalledGateway;
    startGateway?: (params: {
      lane: LaneState;
      cliPath: string;
      env: NodeJS.ProcessEnv;
      logPath: string;
    }) => Promise<unknown>;
    collectDiagnostics?: (
      params: Parameters<typeof collectManagedGatewayReadinessDiagnostics>[0],
    ) => Promise<void>;
    platform?: NodeJS.Platform;
  } = {},
) {
  const waitForGateway = options.waitForGateway ?? waitForInstalledGateway;
  const collectDiagnostics =
    options.collectDiagnostics ?? collectManagedGatewayReadinessDiagnostics;
  const captureDiagnostics = async (phase: ManagedGatewayDiagnosticPhase) => {
    if ((options.platform ?? process.platform) !== "win32") {
      return;
    }
    try {
      await collectDiagnostics({ ...params, phase });
    } catch {
      // Injected/test diagnostic collectors remain non-authoritative too.
    }
  };
  try {
    await waitForGateway(params);
    return;
  } catch {
    await captureDiagnostics("initial");
    try {
      if (options.startGateway) {
        await options.startGateway(params);
      } else {
        await runInstalledCli({
          cliPath: params.cliPath,
          args: ["gateway", "start"],
          cwd: params.lane.homeDir,
          env: params.env,
          logPath: params.logPath,
          timeoutMs: 2 * 60 * 1000,
          check: false,
        });
      }
    } catch (error) {
      await captureDiagnostics("fallback-start");
      throw error;
    }
  }
  try {
    await waitForGateway(params);
  } catch (error) {
    await captureDiagnostics("fallback-start");
    throw error;
  }
}

export async function runInstalledModelsSet(params: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  providerConfig: ProviderConfig;
  logPath: string;
}) {
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["models", "set", params.providerConfig.model],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  const providerConfigOverride = buildReleaseProviderConfigOverride(params.providerConfig);
  if (providerConfigOverride) {
    await runInstalledCli({
      cliPath: params.cliPath,
      args: [
        "config",
        "set",
        `models.providers.${params.providerConfig.extensionId}`,
        JSON.stringify(providerConfigOverride),
        "--strict-json",
        "--merge",
      ],
      cwd: params.cwd,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 2 * 60 * 1000,
    });
  }
  await runInstalledCli({
    cliPath: params.cliPath,
    args: [
      "config",
      "set",
      "plugins.allow",
      JSON.stringify(buildCrossOsReleaseSmokePluginAllowlist(params.providerConfig)),
      "--strict-json",
    ],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: buildCrossOsReleaseSmokeMemorySlotConfigArgs(),
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["config", "set", "agents.defaults.skipBootstrap", "true", "--strict-json"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["config", "set", "tools.profile", CROSS_OS_RELEASE_SMOKE_TOOLS_PROFILE],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
}

export async function runInstalledAgentTurn(params: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
  logPath: string;
}): Promise<AgentTurnResult> {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const sessionId = buildCrossOsReleaseAgentSessionId(params.label, attempt);
    try {
      const logOffset = readLogFileSize(params.logPath);
      const result = await runInstalledCli({
        cliPath: params.cliPath,
        args: buildReleaseAgentTurnArgs(sessionId),
        cwd: params.cwd,
        env: params.env,
        logPath: params.logPath,
        timeoutMs: (CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS + 60) * 1000,
      });
      const logText = readLogTextSince(params.logPath, logOffset);
      if (!agentOutputHasExpectedOkMarker(result.stdout, { logText })) {
        throw new Error("Agent output did not contain the expected OK marker.");
      }
      return result;
    } catch (error) {
      lastError = error;
      const skipped = maybeBuildOptionalAgentTurnSkipResult(error, params.logPath, {
        attempt,
        maxAttempts: 2,
      });
      if (skipped) {
        return skipped;
      }
      if (attempt >= 2 || !shouldRetryCrossOsAgentTurnError(error)) {
        throw error;
      }
      appendFileSync(
        params.logPath,
        `\n[release-checks] retrying installed agent turn after retryable live failure: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  throw lastError;
}

export function verifyDevUpdateStatus(stdout: string, options: { ref?: string } = {}) {
  let payload;
  try {
    payload = JSON.parse(stdout) as {
      update?: { installKind?: string; git?: { branch?: string; sha?: string } };
      channel?: { value?: string; channel?: string };
      installKind?: string;
      git?: { branch?: string; sha?: string };
    };
  } catch {
    payload = null;
  }
  const expectedRef = resolveExpectedDevUpdateRef(options.ref);
  const update = payload?.update ?? payload;
  const installKind = update?.installKind ?? null;
  const branch = update?.git?.branch ?? null;
  const sha = update?.git?.sha ?? null;
  const channelValue = payload?.channel?.value ?? payload?.channel?.channel ?? null;
  if (installKind !== "git") {
    throw new Error(
      `Dev update did not land on a git install. Found ${installKind ?? "<missing>"}.`,
    );
  }
  if (channelValue !== "dev") {
    throw new Error(
      `Dev update status did not report channel=dev. Found ${channelValue ?? "<missing>"}.`,
    );
  }
  if (looksLikeCommitSha(expectedRef)) {
    const normalizedSha = typeof sha === "string" ? sha.toLowerCase() : "";
    const normalizedExpectedRef = expectedRef.toLowerCase();
    if (!normalizedSha || !normalizedSha.startsWith(normalizedExpectedRef)) {
      throw new Error(
        `Dev update status did not report sha=${expectedRef}. Found ${sha ?? "<missing>"}.`,
      );
    }
    return;
  }
  if (branch !== expectedRef) {
    throw new Error(
      `Dev update status did not report branch=${expectedRef}. Found ${branch ?? "<missing>"}.`,
    );
  }
}

export async function verifyWindowsDevUpdateToolchain(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  const script = buildWindowsDevUpdateToolchainCheckScript();
  const result = await runPowerShellScript(script, {
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  if (!parseMarkerLine(result.stdout, "__UPDATE_TOOL__=")) {
    throw new Error(
      "No Windows update bootstrap tool (pnpm, corepack, or npm) was discoverable after the dev update.",
    );
  }
}
