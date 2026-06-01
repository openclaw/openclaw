/**
 * OpenClaw-managed Chrome lifecycle and CDP helpers.
 *
 * Builds launch args, starts/stops managed Chrome, probes CDP readiness, and
 * resolves WebSocket endpoints for browser control.
 */
import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  execFile,
  spawn,
} from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { prepareOomScoreAdjustedSpawn } from "openclaw/plugin-sdk/process-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { ensurePortAvailable } from "../infra/ports.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CONFIG_DIR } from "../utils.js";
import { hasChromeProxyControlArg, omitChromeProxyEnv } from "./browser-proxy-mode.js";
import { assertManagedProxyAllowsCdpUrl } from "./cdp-proxy-bypass.js";
import {
  CHROME_BOOTSTRAP_EXIT_POLL_MS,
  CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS,
  CHROME_BOOTSTRAP_PREFS_POLL_MS,
  CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS,
  CHROME_LAUNCH_READY_POLL_MS,
  CHROME_LAUNCH_READY_WINDOW_MS,
  CHROME_REACHABILITY_TIMEOUT_MS,
  CHROME_STDERR_HINT_MAX_CHARS,
  CHROME_STOP_PROBE_TIMEOUT_MS,
  CHROME_STOP_TIMEOUT_MS,
  CHROME_WS_READY_TIMEOUT_MS,
} from "./cdp-timeouts.js";
import {
  assertCdpEndpointAllowed,
  isDirectCdpWebSocketEndpoint,
  isWebSocketUrl,
  normalizeCdpHttpBaseForJsonEndpoints,
  openCdpWebSocket,
} from "./cdp.helpers.js";
import { normalizeCdpWsUrl } from "./cdp.js";
import {
  type ChromeCdpDiagnostic,
  diagnoseChromeCdp,
  formatChromeCdpDiagnostic,
  type ChromeVersion,
  readChromeVersion,
  safeChromeCdpErrorMessage,
} from "./chrome.diagnostics.js";
import {
  type BrowserExecutable,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
import {
  decorateOpenClawProfile,
  ensureProfileCleanExit,
  isProfileDecorated,
} from "./chrome.profile-decoration.js";
import {
  getManagedBrowserMissingDisplayError,
  resolveManagedBrowserHeadlessMode,
  type ManagedBrowserHeadlessOptions,
  type ManagedBrowserHeadlessSource,
  type ResolvedBrowserConfig,
  type ResolvedBrowserProfile,
} from "./config.js";
import {
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "./constants.js";
import { BrowserProfileUnavailableError } from "./errors.js";
import { ensureOutputDirectory } from "./output-directories.js";
import { DEFAULT_DOWNLOAD_DIR } from "./paths.js";

const log = createSubsystemLogger("browser").child("chrome");
const CHROME_SINGLETON_LOCK_PATHS = [
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
] as const;
const CHROME_SINGLETON_IN_USE_PATTERN = /profile appears to be in use by another chromium process/i;
const CHROME_MISSING_DISPLAY_PATTERN = /missing x server|\$DISPLAY/i;
const LSOF_CANDIDATES =
  process.platform === "darwin"
    ? ["/usr/sbin/lsof", "/usr/bin/lsof"]
    : ["/usr/bin/lsof", "/usr/sbin/lsof"];
const PS_CANDIDATES =
  process.platform === "darwin" || process.platform === "linux" ? ["/bin/ps", "/usr/bin/ps"] : [];
const LINUX_CHROMIUM_PROCESS_FAMILIES: ReadonlyMap<string, string> = new Map([
  ["brave", "brave"],
  ["brave-browser", "brave"],
  ["brave-browser-stable", "brave"],
  ["chrome", "chrome"],
  ["google-chrome", "chrome"],
  ["google-chrome-beta", "chrome"],
  ["google-chrome-stable", "chrome"],
  ["google-chrome-unstable", "chrome"],
  ["chromium", "chromium"],
  ["chromium-browser", "chromium"],
  ["microsoft-edge", "edge"],
  ["microsoft-edge-beta", "edge"],
  ["microsoft-edge-canary", "edge"],
  ["microsoft-edge-dev", "edge"],
  ["microsoft-edge-stable", "edge"],
  ["opera", "opera"],
  ["opera-gx", "opera"],
  ["opera-stable", "opera"],
  ["vivaldi", "vivaldi"],
  ["vivaldi-stable", "vivaldi"],
  ["yandex-browser", "yandex"],
]);
const CHROME_HTTP_DISCOVERY_FAILURE_CODES = new Set([
  "ssrf_blocked",
  "http_unreachable",
  "http_status_failed",
  "invalid_json",
]);

export type { BrowserExecutable } from "./chrome.executables.js";
export {
  diagnoseChromeCdp,
  formatChromeCdpDiagnostic,
  type ChromeCdpDiagnostic,
  type ChromeCdpDiagnosticCode,
} from "./chrome.diagnostics.js";
export {
  findChromeExecutableLinux,
  findChromeExecutableMac,
  findChromeExecutableWindows,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
export {
  decorateOpenClawProfile,
  ensureProfileCleanExit,
  isProfileDecorated,
} from "./chrome.profile-decoration.js";

function exists(filePath: string) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function diagnosticShowsChromeHttpDiscovery(diagnostic: ChromeCdpDiagnostic | null): boolean {
  if (!diagnostic) {
    return false;
  }
  if (diagnostic.ok) {
    return true;
  }
  return !CHROME_HTTP_DISCOVERY_FAILURE_CODES.has(diagnostic.code);
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    return false;
  }
}

function clearChromeSingletonArtifacts(userDataDir: string) {
  for (const basename of CHROME_SINGLETON_LOCK_PATHS) {
    try {
      fs.rmSync(path.join(userDataDir, basename), { force: true });
    } catch {
      // ignore best-effort cleanup
    }
  }
}

async function clearChromeSingletonArtifactsForOwner(
  userDataDir: string,
  owner: ChromeSingletonOwner,
  ownerIdentity: string,
): Promise<boolean> {
  const currentOwner = readChromeSingletonOwner(userDataDir);
  if (!currentOwner) {
    return true;
  }
  if (currentOwner.host !== owner.host || currentOwner.pid !== owner.pid) {
    return false;
  }
  // Keep the PID liveness check adjacent to the unlink calls: a reused PID with
  // the same lock owner string must not lose its new Chrome singleton files.
  if (processExists(owner.pid) || (await processIdentityMatches(owner.pid, ownerIdentity))) {
    return false;
  }
  clearChromeSingletonArtifacts(userDataDir);
  return true;
}

type ChromeSingletonOwner = {
  host: string;
  pid: number;
};

function readChromeSingletonOwner(userDataDir: string): ChromeSingletonOwner | null {
  const lockPath = path.join(userDataDir, "SingletonLock");
  let target: string;
  try {
    target = fs.readlinkSync(lockPath);
  } catch {
    return null;
  }

  const match = /^(?<lockHost>.+)-(?<pid>\d+)$/.exec(target);
  if (!match?.groups) {
    return null;
  }

  const host = normalizeOptionalString(match.groups.lockHost) ?? "";
  const pid = Number.parseInt(match.groups.pid ?? "", 10);
  if (!host || !Number.isInteger(pid) || pid <= 0) {
    // Malformed lock targets do not prove local ownership. Leave them in
    // place instead of deleting an unknown profile owner's lock.
    return null;
  }
  return { host, pid };
}

export function clearStaleChromeSingletonLocks(
  userDataDir: string,
  hostname = os.hostname(),
): boolean {
  const owner = readChromeSingletonOwner(userDataDir);
  if (!owner) {
    return false;
  }
  if (owner.host === hostname && processExists(owner.pid)) {
    return false;
  }

  clearChromeSingletonArtifacts(userDataDir);
  return true;
}

async function waitForChromeProcessExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  if (proc.exitCode != null || proc.signalCode != null || proc.killed) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      proc.off("exit", onExit);
      proc.off("close", onExit);
      resolve();
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    proc.once("exit", onExit);
    proc.once("close", onExit);
  });
}

async function terminateChromeForRetry(proc: ChildProcess, userDataDir: string) {
  try {
    proc.kill("SIGKILL");
  } catch {
    // ignore
  }
  await waitForChromeProcessExit(proc, CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS);
  clearStaleChromeSingletonLocks(userDataDir);
}

function isPortInUseError(err: unknown): boolean {
  const maybeError = err as { name?: unknown; code?: unknown };
  return maybeError.name === "PortInUseError" || maybeError.code === "EADDRINUSE";
}

function resolveExecutableCandidate(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep trying
    }
  }
  return null;
}

function execFileText(
  executable: string,
  args: readonly string[],
  maxBuffer = 64 * 1024,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      { timeout: CHROME_STOP_PROBE_TIMEOUT_MS, maxBuffer },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

async function inspectTcpListenPids(port: number): Promise<Set<number> | null> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return null;
  }
  const lsof = resolveExecutableCandidate(LSOF_CANDIDATES);
  if (!lsof) {
    return null;
  }
  const stdout = await execFileText(lsof, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
  if (!stdout) {
    return null;
  }
  const pids = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^p(?<pid>\d+)$/.exec(line);
    const pid = Number.parseInt(match?.groups?.pid ?? "", 10);
    if (Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return pids.size > 0 ? pids : null;
}

type ProcessCommandLine = {
  args: string[];
  executablePath?: string | null;
  lossy?: boolean;
  raw?: string;
};

async function inspectProcessExecutablePath(pid: number): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }
  const lsof = resolveExecutableCandidate(LSOF_CANDIDATES);
  if (!lsof) {
    return null;
  }
  const stdout = await execFileText(lsof, ["-p", String(pid), "-a", "-d", "txt", "-Fn"]);
  for (const line of (stdout ?? "").split(/\r?\n/)) {
    if (line.startsWith("n/") && !line.includes("/usr/lib/dyld")) {
      return line.slice(1);
    }
  }
  return null;
}

async function readProcessIdentity(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = raw
        .slice(raw.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      return fields[19] ? `linux:${fields[19]}` : null;
    } catch {
      return null;
    }
  }
  const ps = resolveExecutableCandidate(PS_CANDIDATES);
  if (!ps || process.platform !== "darwin") {
    return null;
  }
  const stdout = await execFileText(ps, ["-p", String(pid), "-o", "lstart="], 4 * 1024);
  const startedAt = normalizeOptionalString(stdout?.trim() ?? "");
  return startedAt ? `ps:${startedAt}` : null;
}

async function processIdentityMatches(pid: number, identity: string): Promise<boolean> {
  return (await readProcessIdentity(pid)) === identity;
}

async function readProcessCommandLine(pid: number): Promise<ProcessCommandLine | null> {
  if (process.platform === "linux") {
    try {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      return args.length > 0 ? { args } : null;
    } catch {
      return null;
    }
  }
  const ps = resolveExecutableCandidate(PS_CANDIDATES);
  if (!ps) {
    return null;
  }
  const raw = (await execFileText(ps, ["-ww", "-p", String(pid), "-o", "command="]))?.trim();
  if (!raw) {
    return null;
  }
  return {
    args: raw.split(/\s+/),
    executablePath: await inspectProcessExecutablePath(pid),
    lossy: true,
    raw,
  };
}

function hasRawCommandLineUnsafeChars(value: string): boolean {
  return /\s|["']/.test(value);
}

function argsHaveAdjacentPair(args: readonly string[], first: string, second: string): boolean {
  return args.some((arg, index) => arg === first && args[index + 1] === second);
}

function linuxChromiumProcessFamily(executablePath: string): string | null {
  return LINUX_CHROMIUM_PROCESS_FAMILIES.get(path.basename(executablePath).toLowerCase()) ?? null;
}

function commandLineMatchesResolvedExecutable(
  cmdline: ProcessCommandLine,
  executablePath: string,
): boolean {
  if (cmdline.lossy) {
    if (process.platform === "darwin") {
      return (
        cmdline.executablePath === executablePath &&
        typeof cmdline.raw === "string" &&
        (cmdline.raw === executablePath || cmdline.raw.startsWith(`${executablePath} `))
      );
    }
    if (hasRawCommandLineUnsafeChars(executablePath)) {
      return false;
    }
  }
  if (cmdline.args[0] === executablePath) {
    return true;
  }
  if (process.platform !== "linux") {
    return false;
  }
  const actualExecutable = cmdline.args[0];
  if (!actualExecutable) {
    return false;
  }
  const expectedFamily = linuxChromiumProcessFamily(executablePath);
  return expectedFamily !== null && expectedFamily === linuxChromiumProcessFamily(actualExecutable);
}

function rawCommandLineHasManagedLaunchPrefix(params: {
  executablePath: string;
  raw: string;
  remoteDebuggingPortArg: string;
  userDataDirArg: string;
}): boolean {
  const expectedPrefix = `${params.executablePath} ${params.remoteDebuggingPortArg} ${params.userDataDirArg} --no-first-run`;
  return params.raw === expectedPrefix || params.raw.startsWith(`${expectedPrefix} `);
}

async function isManagedChromeProcessForProfile(params: {
  executablePath: string;
  pid: number;
  profile: ResolvedBrowserProfile;
  userDataDir: string;
}): Promise<boolean> {
  const cmdline = await readProcessCommandLine(params.pid);
  if (!cmdline) {
    return false;
  }
  const remoteDebuggingPortArg = `--remote-debugging-port=${params.profile.cdpPort}`;
  const userDataDirArg = `--user-data-dir=${params.userDataDir}`;
  if (cmdline.lossy && process.platform === "darwin" && typeof cmdline.raw === "string") {
    return (
      commandLineMatchesResolvedExecutable(cmdline, params.executablePath) &&
      rawCommandLineHasManagedLaunchPrefix({
        executablePath: params.executablePath,
        raw: cmdline.raw,
        remoteDebuggingPortArg,
        userDataDirArg,
      })
    );
  }
  // Recovery relies on the canonical launch-arg ordering from
  // buildOpenClawChromeLaunchArgs(); a reordered process is not safe to signal.
  return (
    commandLineMatchesResolvedExecutable(cmdline, params.executablePath) &&
    argsHaveAdjacentPair(cmdline.args, remoteDebuggingPortArg, userDataDirArg) &&
    argsHaveAdjacentPair(cmdline.args, userDataDirArg, "--no-first-run")
  );
}

async function isLoopbackPortAccepting(port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForProcessExitByPid(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!processExists(pid)) {
      return true;
    }
    const remainingMs = timeoutMs - (Date.now() - start);
    await new Promise((r) => {
      setTimeout(r, Math.max(1, Math.min(CHROME_BOOTSTRAP_EXIT_POLL_MS, remainingMs)));
    });
  }
  return !processExists(pid);
}

async function stopOwnedChromePid(
  pid: number,
  isStillOwnedChrome: () => Promise<boolean>,
): Promise<boolean> {
  if (!(await isStillOwnedChrome())) {
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ignore; the second port check below is the source of truth
  }
  if (await waitForProcessExitByPid(pid, CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS)) {
    return true;
  }
  if (!(await isStillOwnedChrome())) {
    return false;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore; the second port check below is the source of truth
  }
  return await waitForProcessExitByPid(pid, CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS);
}

async function waitForLoopbackPortClosed(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isLoopbackPortAccepting(port, CHROME_STOP_PROBE_TIMEOUT_MS))) {
      return true;
    }
    const remainingMs = timeoutMs - (Date.now() - start);
    await new Promise((r) => {
      setTimeout(r, Math.max(1, Math.min(CHROME_BOOTSTRAP_EXIT_POLL_MS, remainingMs)));
    });
  }
  return !(await isLoopbackPortAccepting(port, CHROME_STOP_PROBE_TIMEOUT_MS));
}

async function waitForOwnedChromeCdpToStayUnready(params: {
  profile: ResolvedBrowserProfile;
  isStillOwnedChrome: () => Promise<boolean>;
  timeoutMs: number;
}): Promise<boolean> {
  const timeoutMs = Math.max(1, params.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (!(await params.isStillOwnedChrome())) {
      return false;
    }
    if (
      await isChromeCdpReady(
        params.profile.cdpUrl,
        CHROME_REACHABILITY_TIMEOUT_MS,
        CHROME_WS_READY_TIMEOUT_MS,
      )
    ) {
      return false;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return true;
    }
    await new Promise((r) => {
      setTimeout(r, Math.max(1, Math.min(CHROME_LAUNCH_READY_POLL_MS, remainingMs)));
    });
  }
}

async function recoverOwnedChromePortBlocker(params: {
  executablePath: string;
  profile: ResolvedBrowserProfile;
  readinessTimeoutMs: number;
  userDataDir: string;
}): Promise<boolean> {
  if (!params.profile.cdpIsLoopback) {
    return false;
  }
  const owner = readChromeSingletonOwner(params.userDataDir);
  if (!owner || owner.host !== os.hostname() || !processExists(owner.pid)) {
    return false;
  }
  const ownerIdentity = await readProcessIdentity(owner.pid);
  if (!ownerIdentity) {
    return false;
  }
  const isStillOwnedChrome = async () => {
    if (!(await processIdentityMatches(owner.pid, ownerIdentity))) {
      return false;
    }
    const listenerPids = await inspectTcpListenPids(params.profile.cdpPort);
    if (!listenerPids?.has(owner.pid)) {
      return false;
    }
    return await isManagedChromeProcessForProfile({
      executablePath: params.executablePath,
      pid: owner.pid,
      profile: params.profile,
      userDataDir: params.userDataDir,
    });
  };
  if (!(await isStillOwnedChrome())) {
    return false;
  }
  if (
    !(await waitForOwnedChromeCdpToStayUnready({
      profile: params.profile,
      isStillOwnedChrome,
      timeoutMs: params.readinessTimeoutMs,
    }))
  ) {
    return false;
  }

  log.warn(
    `Stopping unresponsive managed Chrome for profile "${params.profile.name}" on port ${params.profile.cdpPort} (pid ${owner.pid}) before relaunch.`,
  );
  if (!(await stopOwnedChromePid(owner.pid, isStillOwnedChrome))) {
    return false;
  }
  if (
    !(await waitForLoopbackPortClosed(params.profile.cdpPort, CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS))
  ) {
    return false;
  }
  if (processExists(owner.pid)) {
    return false;
  }
  return await clearChromeSingletonArtifactsForOwner(params.userDataDir, owner, ownerIdentity);
}

async function ensureManagedLoopbackPortAvailable(params: {
  executablePath: string;
  profile: ResolvedBrowserProfile;
  readinessTimeoutMs: number;
  userDataDir: string;
}): Promise<void> {
  if (!params.profile.cdpIsLoopback) {
    await ensurePortAvailable(params.profile.cdpPort);
    return;
  }
  try {
    await ensurePortAvailable(params.profile.cdpPort);
  } catch (err) {
    if (!isPortInUseError(err) || !(await recoverOwnedChromePortBlocker(params))) {
      throw err;
    }
    await ensurePortAvailable(params.profile.cdpPort);
  }

  const owner = readChromeSingletonOwner(params.userDataDir);
  if (!owner || owner.host !== os.hostname() || !processExists(owner.pid)) {
    return;
  }
  // Some hosts can accept a generic listen probe while 127.0.0.1 is still
  // held. Only use the exact loopback probe after SingletonLock proves local
  // managed-profile ownership, so external CDP services are not killed by port.
  if (!(await isLoopbackPortAccepting(params.profile.cdpPort, CHROME_STOP_PROBE_TIMEOUT_MS))) {
    return;
  }
  const err = new Error(`Port ${params.profile.cdpPort} is already in use.`);
  err.name = "PortInUseError";
  if (await recoverOwnedChromePortBlocker(params)) {
    return;
  }
  throw err;
}

function chromeLaunchHints(params: {
  stderrOutput: string;
  resolved: ResolvedBrowserConfig;
  profile: ResolvedBrowserProfile;
  launchOptions?: ManagedBrowserHeadlessOptions;
}): string {
  const hints: string[] = [];
  if (process.platform === "linux" && !params.resolved.noSandbox) {
    hints.push("If running in a container or as root, try setting browser.noSandbox: true.");
  }
  const headlessMode = resolveManagedBrowserHeadlessMode(
    params.resolved,
    params.profile,
    params.launchOptions,
  );
  if (CHROME_MISSING_DISPLAY_PATTERN.test(params.stderrOutput) && !headlessMode.headless) {
    hints.push(
      "No DISPLAY/X server was detected. Set OPENCLAW_BROWSER_HEADLESS=1, remove the headed override, start Xvfb, or run the Gateway in a desktop session.",
    );
  }
  if (CHROME_SINGLETON_IN_USE_PATTERN.test(params.stderrOutput)) {
    hints.push(
      `The Chromium profile "${params.profile.name}" is locked. Stop the existing browser or remove stale Singleton* lock files under ~/.openclaw/browser/${params.profile.name}/user-data.`,
    );
  }
  return hints.length > 0 ? `\nHint: ${hints.join("\nHint: ")}` : "";
}

/** Running managed Chrome process and resolved control metadata. */
export type RunningChrome = {
  pid: number;
  exe: BrowserExecutable;
  userDataDir: string;
  cdpPort: number;
  startedAt: number;
  proc: ChildProcess;
  headless?: boolean;
  headlessSource?: ManagedBrowserHeadlessSource;
  /**
   * @deprecated CDP managed-proxy bypasses are scoped at exact request URLs.
   * Kept so older in-memory callers can pass stale RunningChrome objects
   * through stopOpenClawChrome without type churn.
   */
  releaseCdpProxyBypass?: () => void;
};

function resolveBrowserExecutable(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
): BrowserExecutable | null {
  return resolveBrowserExecutableForPlatform(
    { ...resolved, executablePath: profile.executablePath ?? resolved.executablePath },
    process.platform,
  );
}

/** Resolve the user-data-dir path for a managed OpenClaw Chrome profile. */
export function resolveOpenClawUserDataDir(profileName = DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME) {
  return path.join(CONFIG_DIR, "browser", profileName, "user-data");
}

function cdpUrlForPort(cdpPort: number) {
  return `http://127.0.0.1:${cdpPort}`;
}

/** Build Chrome launch arguments for the managed OpenClaw browser. */
export function buildOpenClawChromeLaunchArgs(params: {
  resolved: ResolvedBrowserConfig;
  profile: ResolvedBrowserProfile;
  userDataDir: string;
  headlessOverride?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): string[] {
  const { resolved, profile, userDataDir } = params;
  const headlessMode = resolveManagedBrowserHeadlessMode(resolved, profile, params);
  const args: string[] = [
    `--remote-debugging-port=${profile.cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=Translate,MediaRouter",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--password-store=basic",
  ];

  if (headlessMode.headless) {
    args.push("--headless=new");
    args.push("--disable-gpu");
  }
  if (resolved.noSandbox) {
    args.push("--no-sandbox");
  }
  if (process.platform === "linux") {
    args.push("--disable-dev-shm-usage");
  }
  if (!hasChromeProxyControlArg(resolved.extraArgs)) {
    args.push("--no-proxy-server");
  }
  if (resolved.extraArgs.length > 0) {
    args.push(...resolved.extraArgs);
  }

  return args;
}

async function canOpenWebSocket(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const ws = openCdpWebSocket(url, { handshakeTimeoutMs: timeoutMs });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    ws.once("open", () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      finish(true);
    });
    ws.once("error", () => finish(false));
    ws.once("close", () => finish(false));
  });
}

/** Return true when a Chrome CDP endpoint is reachable over HTTP. */
export async function isChromeReachable(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
): Promise<boolean> {
  try {
    await assertCdpEndpointAllowed(cdpUrl, ssrfPolicy);
    if (isDirectCdpWebSocketEndpoint(cdpUrl)) {
      // Handshake-ready direct WS endpoint — probe via WS handshake.
      return await canOpenWebSocket(cdpUrl, timeoutMs);
    }
    // Either an http(s) discovery URL or a bare ws/wss root. Try
    // /json/version discovery first. For bare ws/wss URLs, fall back to a
    // direct WS handshake when discovery is unavailable — some providers
    // (e.g. Browserless/Browserbase) expose a direct WebSocket root without
    // a /json/version endpoint.
    const discoveryUrl = isWebSocketUrl(cdpUrl)
      ? normalizeCdpHttpBaseForJsonEndpoints(cdpUrl)
      : cdpUrl;
    const version = await fetchChromeVersion(discoveryUrl, timeoutMs, ssrfPolicy);
    if (version) {
      return true;
    }
    if (isWebSocketUrl(cdpUrl)) {
      return await canOpenWebSocket(cdpUrl, timeoutMs);
    }
    return false;
  } catch {
    return false;
  }
}

async function fetchChromeVersion(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
): Promise<ChromeVersion | null> {
  try {
    return await readChromeVersion(cdpUrl, timeoutMs, ssrfPolicy);
  } catch {
    return null;
  }
}

/** Resolve a usable Chrome DevTools WebSocket URL from a CDP endpoint. */
export async function getChromeWebSocketUrl(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
): Promise<string | null> {
  await assertCdpEndpointAllowed(cdpUrl, ssrfPolicy);
  if (isDirectCdpWebSocketEndpoint(cdpUrl)) {
    // Handshake-ready direct WebSocket endpoint — the cdpUrl is already
    // the WebSocket URL.
    return cdpUrl;
  }
  // Either an http(s) endpoint or a bare ws/wss root; discover the
  // actual WebSocket URL via /json/version. Normalise the scheme so
  // fetch() can reach the endpoint.
  const discoveryUrl = isWebSocketUrl(cdpUrl)
    ? normalizeCdpHttpBaseForJsonEndpoints(cdpUrl)
    : cdpUrl;
  const version = await fetchChromeVersion(discoveryUrl, timeoutMs, ssrfPolicy);
  const wsUrl = normalizeOptionalString(version?.webSocketDebuggerUrl) ?? "";
  if (!wsUrl) {
    // /json/version unavailable or returned no WebSocket URL. For bare
    // ws/wss inputs, the URL itself may be a direct WebSocket endpoint
    // (e.g. Browserless/Browserbase-style providers without /json/version).
    // The SSRF check on cdpUrl was already performed at the start of this
    // function, so we can return it directly.
    if (isWebSocketUrl(cdpUrl)) {
      return cdpUrl;
    }
    return null;
  }
  const normalizedWsUrl = normalizeCdpWsUrl(wsUrl, discoveryUrl);
  await assertCdpEndpointAllowed(normalizedWsUrl, ssrfPolicy);
  return normalizedWsUrl;
}

/** Return true when a Chrome CDP endpoint has a healthy WebSocket command path. */
export async function isChromeCdpReady(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  handshakeTimeoutMs = CHROME_WS_READY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
): Promise<boolean> {
  const diagnostic = await diagnoseChromeCdp(cdpUrl, timeoutMs, handshakeTimeoutMs, ssrfPolicy);
  if (!diagnostic.ok) {
    log.debug(formatChromeCdpDiagnostic(diagnostic));
  }
  return diagnostic.ok;
}

/** Launch or attach to the managed OpenClaw Chrome profile. */
export async function launchOpenClawChrome(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
  launchOptions: ManagedBrowserHeadlessOptions = {},
): Promise<RunningChrome> {
  if (!profile.cdpIsLoopback) {
    throw new Error(`Profile "${profile.name}" is remote; cannot launch local Chrome.`);
  }
  const headlessMode = resolveManagedBrowserHeadlessMode(resolved, profile, launchOptions);
  const missingDisplayError = getManagedBrowserMissingDisplayError(
    resolved,
    profile,
    launchOptions,
  );
  if (missingDisplayError) {
    throw new BrowserProfileUnavailableError(missingDisplayError);
  }

  // Surface `loopbackMode=block` before spawning Chrome. The CDP fetch and
  // WebSocket helpers install exact-URL bypasses for `/json/version` and
  // `ws://.../devtools/...`.
  try {
    assertManagedProxyAllowsCdpUrl(profile.cdpUrl);
  } catch (err) {
    throw new BrowserProfileUnavailableError(
      `Browser profile "${profile.name}" cannot launch: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const exe = resolveBrowserExecutable(resolved, profile);
  if (!exe) {
    throw new Error(
      "No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).",
    );
  }

  const userDataDir = resolveOpenClawUserDataDir(profile.name);
  fs.mkdirSync(userDataDir, { recursive: true });
  await ensureManagedLoopbackPortAvailable({
    executablePath: exe.path,
    profile,
    readinessTimeoutMs: resolved.localLaunchTimeoutMs ?? CHROME_LAUNCH_READY_WINDOW_MS,
    userDataDir,
  });
  await ensureOutputDirectory(DEFAULT_DOWNLOAD_DIR);

  const needsDecorate = !isProfileDecorated(
    userDataDir,
    profile.name,
    (profile.color ?? DEFAULT_OPENCLAW_BROWSER_COLOR).toUpperCase(),
    DEFAULT_DOWNLOAD_DIR,
  );

  // First launch to create preference files if missing, then decorate and relaunch.
  const spawnOnce = () => {
    const args = buildOpenClawChromeLaunchArgs({
      resolved,
      profile,
      userDataDir,
      ...launchOptions,
    });
    const env: NodeJS.ProcessEnv = {
      ...omitChromeProxyEnv(process.env),
      // Reduce accidental sharing with the user's env.
      HOME: os.homedir(),
    };
    if (process.platform === "linux") {
      const chromiumStateDir = path.join(resolvePreferredOpenClawTmpDir(), ".chromium");
      env.XDG_CONFIG_HOME ??= chromiumStateDir;
      env.XDG_CACHE_HOME ??= chromiumStateDir;
    }
    // stdio tuple: discard stdout to prevent buffer saturation in constrained
    // environments (e.g. Docker), while keeping stderr piped for diagnostics.
    // Cast to ChildProcessWithoutNullStreams so callers can use .stderr safely;
    // the tuple overload resolution varies across @types/node versions.
    const preparedSpawn = prepareOomScoreAdjustedSpawn(exe.path, args, {
      env,
    });
    return spawn(preparedSpawn.command, preparedSpawn.args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: preparedSpawn.env,
    }) as unknown as ChildProcessWithoutNullStreams;
  };

  const startedAt = Date.now();

  const localStatePath = path.join(userDataDir, "Local State");
  const preferencesPath = path.join(userDataDir, "Default", "Preferences");
  const needsBootstrap = !exists(localStatePath) || !exists(preferencesPath);

  // If the profile doesn't exist yet, bootstrap it once so Chrome creates defaults.
  // Then decorate (if needed) before the "real" run.
  if (needsBootstrap) {
    const bootstrap = spawnOnce();
    const deadline = Date.now() + CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exists(localStatePath) && exists(preferencesPath)) {
        break;
      }
      await new Promise((r) => {
        setTimeout(r, CHROME_BOOTSTRAP_PREFS_POLL_MS);
      });
    }
    try {
      bootstrap.kill("SIGTERM");
    } catch {
      // ignore
    }
    const exitDeadline = Date.now() + CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS;
    while (Date.now() < exitDeadline) {
      if (bootstrap.exitCode != null) {
        break;
      }
      await new Promise((r) => {
        setTimeout(r, CHROME_BOOTSTRAP_EXIT_POLL_MS);
      });
    }
  }

  if (needsDecorate) {
    try {
      decorateOpenClawProfile(userDataDir, {
        name: profile.name,
        color: profile.color,
        downloadDir: DEFAULT_DOWNLOAD_DIR,
      });
      log.info(`🦞 openclaw browser profile decorated (${profile.color})`);
    } catch (err) {
      log.warn(`openclaw browser profile decoration failed: ${String(err)}`);
    }
  }

  try {
    ensureProfileCleanExit(userDataDir);
  } catch (err) {
    log.warn(`openclaw browser clean-exit prefs failed: ${String(err)}`);
  }

  const launchOnceAndWait = async (allowSingletonRecovery: boolean): Promise<RunningChrome> => {
    const proc = spawnOnce();

    // Collect stderr for diagnostics in case Chrome fails to start.
    // The listener is removed on success to avoid unbounded memory growth
    // from a long-lived Chrome process that emits periodic warnings.
    const stderrChunks: Buffer[] = [];
    const onStderr = (chunk: Buffer) => {
      stderrChunks.push(chunk);
    };
    proc.stderr?.on("data", onStderr);

    try {
      const readyDeadline =
        Date.now() + (resolved.localLaunchTimeoutMs ?? CHROME_LAUNCH_READY_WINDOW_MS);
      let launchHttpReachable = false;
      // Full CDP WebSocket readiness is handled by the caller's
      // waitForCdpReadyAfterLaunch() budget; launch only owns process discovery.
      while (Date.now() < readyDeadline) {
        if (await isChromeReachable(profile.cdpUrl)) {
          launchHttpReachable = true;
          break;
        }
        await new Promise((r) => {
          setTimeout(r, CHROME_LAUNCH_READY_POLL_MS);
        });
      }

      if (!launchHttpReachable) {
        let finalDiagnostic: ChromeCdpDiagnostic | null = null;
        let diagnosticErrorText: string | null = null;
        try {
          finalDiagnostic = await diagnoseChromeCdp(
            profile.cdpUrl,
            CHROME_REACHABILITY_TIMEOUT_MS,
            CHROME_WS_READY_TIMEOUT_MS,
          );
        } catch (err) {
          diagnosticErrorText = `CDP diagnostic failed: ${safeChromeCdpErrorMessage(err)}.`;
        }
        if (diagnosticShowsChromeHttpDiscovery(finalDiagnostic)) {
          launchHttpReachable = true;
        }
        const diagnosticText = finalDiagnostic
          ? formatChromeCdpDiagnostic(finalDiagnostic)
          : (diagnosticErrorText ?? "CDP diagnostic failed.");
        if (launchHttpReachable) {
          log.debug(diagnosticText);
        } else {
          const stderrOutput =
            normalizeOptionalString(Buffer.concat(stderrChunks).toString("utf8")) ?? "";
          const redactedStderrOutput = redactToolPayloadText(stderrOutput);
          if (
            allowSingletonRecovery &&
            CHROME_SINGLETON_IN_USE_PATTERN.test(stderrOutput) &&
            clearStaleChromeSingletonLocks(userDataDir)
          ) {
            log.warn(
              `Removed stale Chromium Singleton* locks for profile "${profile.name}" and retrying launch.`,
            );
            await terminateChromeForRetry(proc, userDataDir);
            return await launchOnceAndWait(false);
          }
          const stderrHint = redactedStderrOutput
            ? `\nChrome stderr:\n${redactedStderrOutput.slice(0, CHROME_STDERR_HINT_MAX_CHARS)}`
            : "";
          const launchHints = chromeLaunchHints({ stderrOutput, resolved, profile, launchOptions });
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
          throw new Error(
            `Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}". ${diagnosticText}${launchHints}${stderrHint}`,
          );
        }
      }

      const pid = proc.pid ?? -1;
      log.info(
        `🦞 openclaw browser started (${exe.kind}) profile "${profile.name}" on 127.0.0.1:${profile.cdpPort} (pid ${pid})`,
      );

      return {
        pid,
        exe,
        userDataDir,
        cdpPort: profile.cdpPort,
        startedAt,
        proc,
        headless: headlessMode.headless,
        headlessSource: headlessMode.source,
      };
    } finally {
      // Chrome started successfully or launch failed — detach the stderr listener
      // and release the buffer.
      proc.stderr?.off("data", onStderr);
      stderrChunks.length = 0;
    }
  };

  return await launchOnceAndWait(true);
}

/** Stop a managed Chrome process and wait for shutdown. */
export async function stopOpenClawChrome(
  running: RunningChrome,
  timeoutMs = CHROME_STOP_TIMEOUT_MS,
) {
  const proc = running.proc;
  try {
    if (proc.killed) {
      return;
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!proc.exitCode && proc.killed) {
        break;
      }
      if (
        !(await isChromeReachable(cdpUrlForPort(running.cdpPort), CHROME_STOP_PROBE_TIMEOUT_MS))
      ) {
        return;
      }
      const remainingMs = timeoutMs - (Date.now() - start);
      await new Promise((r) => {
        setTimeout(r, Math.max(1, Math.min(100, remainingMs)));
      });
    }

    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
  } finally {
    // Release the managed-proxy bypass we registered at launch time. Wrapped
    // in try/catch + nulled out so a double-stop is a no-op and a failing
    // release does not mask a teardown error.
    const release = running.releaseCdpProxyBypass;
    if (release) {
      running.releaseCdpProxyBypass = undefined;
      try {
        release();
      } catch {
        // best-effort; the bypass survives until process exit at worst
      }
    }
  }
}
