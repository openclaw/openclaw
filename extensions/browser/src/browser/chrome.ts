/**
 * OpenClaw-managed Chrome lifecycle and CDP helpers.
 *
 * Builds launch args, starts/stops managed Chrome, probes CDP readiness, and
 * resolves WebSocket endpoints for browser control.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isPidAlive, prepareOomScoreAdjustedSpawn } from "openclaw/plugin-sdk/process-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { ensurePortAvailable } from "../infra/ports.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CONFIG_DIR } from "../utils.js";
import { createBoundedUtf8Tail } from "./bounded-utf8-tail.js";
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
  MANAGED_CDP_READY_HTTP_TIMEOUT_MS,
} from "./cdp-timeouts.js";
import {
  assertCdpEndpointAllowed,
  isDirectCdpWebSocketEndpoint,
  isWebSocketUrl,
  normalizeCdpHttpBaseForJsonEndpoints,
  scopeCdpPolicyToConfiguredEndpoint,
  withCdpSocket,
} from "./cdp.helpers.js";
import { normalizeCdpWsUrl } from "./cdp.js";
import {
  type ChromeCdpDiagnostic,
  diagnoseChromeCdp,
  formatChromeCdpDiagnostic,
  type ChromeVersion,
  readChromeVersionWithCredentialFallback,
  safeChromeCdpErrorMessage,
} from "./chrome.diagnostics.js";
import {
  type BrowserExecutable,
  assertBrowserExecutableSupportsLaunch,
  processCommandUsesHeadlessChrome,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
import {
  headlessShellProfileInUseReason,
  isHeadlessShellExecutable,
  pidListensOnPort,
  processCommandHasFlag,
  readManagedProcessCommandLine,
  readOwnedManagedChromeIdentity,
  readOwnedManagedHeadlessShell,
  readPortListenerPids,
  sameManagedChromeIdentity,
  type ManagedChromeProcessIdentity,
} from "./chrome.process-ownership.js";
import {
  decorateOpenClawProfile,
  ensureProfileCleanExit,
  ensureProfileNetworkPredictionDisabled,
  isProfileDecorated,
  usesOpenClawMockKeychain,
} from "./chrome.profile-decoration.js";
import { withChromeProfileLifecycleLock } from "./chrome.profile-lifecycle-lock.js";
import type { BrowserGraphicsDiagnostics } from "./client.types.js";
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
import { BROWSER_ERROR_REASONS, BrowserProfileUnavailableError } from "./errors.js";
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
const CHROME_GRACEFUL_CLOSE_COMMAND_TIMEOUT_MS = 500;
const CHROME_LAUNCH_STDERR_TAIL_MAX_BYTES = 64 * 1024;
const CHROME_STDERR_MARKER_SCAN_TAIL_CHARS = 256;
const CHROME_HTTP_DISCOVERY_FAILURE_CODES = new Set([
  "ssrf_blocked",
  "http_unreachable",
  "http_status_failed",
  "invalid_json",
]);

function diagnosticShowsChromeHttpDiscovery(diagnostic: ChromeCdpDiagnostic | null): boolean {
  if (!diagnostic) {
    return false;
  }
  if (diagnostic.ok) {
    return true;
  }
  return !CHROME_HTTP_DISCOVERY_FAILURE_CODES.has(diagnostic.code);
}

type ChromeLaunchStderrSignals = {
  singletonInUse: boolean;
  missingDisplay: boolean;
};

function createChromeLaunchStderrDiagnostics(maxBytes: number) {
  const tail = createBoundedUtf8Tail(maxBytes);
  const signals: ChromeLaunchStderrSignals = {
    singletonInUse: false,
    missingDisplay: false,
  };
  let markerScanTail = "";

  const updateSignals = (chunkText: string) => {
    const scanText = `${markerScanTail}${chunkText}`;
    signals.singletonInUse ||= CHROME_SINGLETON_IN_USE_PATTERN.test(scanText);
    signals.missingDisplay ||= CHROME_MISSING_DISPLAY_PATTERN.test(scanText);
    markerScanTail = scanText.slice(-CHROME_STDERR_MARKER_SCAN_TAIL_CHARS);
  };

  return {
    append(chunk: Buffer | string) {
      tail.append(chunk);
      const chunkText = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (chunkText.length > 0) {
        updateSignals(chunkText);
      }
    },
    toString() {
      return tail.text();
    },
    signals(): ChromeLaunchStderrSignals {
      return { ...signals };
    },
    clear() {
      tail.clear();
      signals.singletonInUse = false;
      signals.missingDisplay = false;
      markerScanTail = "";
    },
  };
}

type ChromeSingletonLock =
  | { status: "missing" }
  | { status: "invalid"; reason: string }
  | { status: "owner"; hostname: string; pid: number };

function readSingletonLockTarget(userDataDir: string): ChromeSingletonLock {
  let target: string;
  try {
    target = fs.readlinkSync(path.join(userDataDir, "SingletonLock"));
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid", reason: "Chromium profile lock could not be read" };
  }
  const match = /^(?<lockHost>.+)-(?<pid>\d+)$/.exec(target);
  if (!match?.groups) {
    return { status: "invalid", reason: "Chromium profile lock is malformed" };
  }
  const hostname = normalizeOptionalString(match.groups.lockHost) ?? "";
  const pid = Number.parseInt(match.groups.pid ?? "", 10);
  if (!hostname || !Number.isSafeInteger(pid) || pid <= 0) {
    return { status: "invalid", reason: "Chromium profile lock is malformed" };
  }
  return { status: "owner", hostname, pid };
}

function unverifiedSingletonLockReason(lock: ChromeSingletonLock): string | undefined {
  if (lock.status === "invalid") {
    return lock.reason;
  }
  if (lock.status === "owner" && lock.hostname !== os.hostname()) {
    return "Chromium profile lock names another hostname";
  }
  return undefined;
}

function resolveOwnedManagedChromeIdentity(params: {
  resolved: ResolvedBrowserConfig;
  profile: ResolvedBrowserProfile;
  userDataDir: string;
  pid: number;
  headlessShellOnly?: boolean;
}): { exe: BrowserExecutable; identity: ManagedChromeProcessIdentity } | null {
  const shell = readOwnedManagedHeadlessShell(params);
  if (shell) {
    return shell;
  }
  // One-shot launches can differ from persisted mode. Discovery is not authority:
  // either candidate must pass the same live PID, port, command, and profile proof.
  for (const headless of [false, true]) {
    const exe = resolveBrowserExecutable(params.resolved, params.profile, headless);
    const identity = exe && readOwnedManagedChromeIdentity({ ...params, exe });
    if (exe && identity) {
      return { exe, identity };
    }
  }
  return null;
}

function resolveOwnedManagedChromeListener(params: {
  resolved: ResolvedBrowserConfig;
  profile: ResolvedBrowserProfile;
  userDataDir: string;
  lock: ChromeSingletonLock;
}): ReturnType<typeof resolveOwnedManagedChromeIdentity> {
  if (params.lock.status === "owner") {
    if (params.lock.hostname !== os.hostname()) {
      return null;
    }
    if (isPidAlive(params.lock.pid)) {
      return resolveOwnedManagedChromeIdentity({ ...params, pid: params.lock.pid });
    }
  } else if (params.lock.status !== "missing") {
    return null;
  }
  // Headless shell never creates SingletonLock. Discover its listener, then use
  // the same live PID, start time, exact port, and profile proof as locked Chrome.
  // A dead local lock can remain from an earlier full Chromium launch.
  // Full Chrome without its lock must not gain this alternate ownership path.
  const pids = readPortListenerPids(params.profile.cdpPort);
  const [pid] = pids;
  if (pids.length !== 1 || pid === undefined) {
    return null;
  }
  return resolveOwnedManagedChromeIdentity({
    ...params,
    pid,
    headlessShellOnly: true,
  });
}

function isPortInUseError(err: unknown): boolean {
  const errno = (err as NodeJS.ErrnoException | undefined)?.code;
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  return (
    errno === "EADDRINUSE" ||
    name === "PortInUseError" ||
    /\bEADDRINUSE\b|already in use/i.test(message)
  );
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

/** Remove stale Chrome singleton lock files from a user-data-dir. */
function clearStaleChromeSingletonLocks(userDataDir: string, hostname = os.hostname()): boolean {
  const lock = readSingletonLockTarget(userDataDir);
  if (lock.status !== "owner" || lock.hostname !== hostname || isPidAlive(lock.pid)) {
    return false;
  }

  clearChromeSingletonArtifacts(userDataDir);
  return true;
}

async function waitForChromeProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  // ChildProcess state/events identify the spawned child; a bare PID probe can
  // mistake a later process that reused the number for the retained child.
  if (proc.exitCode != null || proc.signalCode != null) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      proc.off("exit", onExit);
      proc.off("close", onExit);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    proc.once("exit", onExit);
    proc.once("close", onExit);
    if (proc.exitCode != null || proc.signalCode != null) {
      onExit();
    }
  });
}

async function signalChromeProcess(
  proc: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<boolean> {
  if (proc.exitCode != null || proc.signalCode != null) {
    return true;
  }
  try {
    proc.kill(signal);
  } catch {
    // ignore
  }
  return await waitForChromeProcessExit(proc, timeoutMs);
}

async function terminateChromeForRetry(proc: ChildProcess, userDataDir: string): Promise<boolean> {
  if (!(await signalChromeProcess(proc, "SIGKILL", CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS))) {
    return false;
  }
  clearStaleChromeSingletonLocks(userDataDir);
  return true;
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, CHROME_BOOTSTRAP_EXIT_POLL_MS);
    });
  }
  return !isPidAlive(pid);
}

async function terminateOwnedStaleChromeProcess(
  params: {
    identity: ManagedChromeProcessIdentity;
    exe: BrowserExecutable;
    profile: ResolvedBrowserProfile;
    userDataDir: string;
  },
  timeoutMs = CHROME_STOP_TIMEOUT_MS,
): Promise<boolean> {
  const readCurrentIdentity = () =>
    readOwnedManagedChromeIdentity({
      pid: params.identity.pid,
      exe: params.exe,
      profile: params.profile,
      userDataDir: params.userDataDir,
    });
  const beforeSigterm = readCurrentIdentity();
  if (!beforeSigterm || !sameManagedChromeIdentity(params.identity, beforeSigterm)) {
    return false;
  }
  try {
    process.kill(params.identity.pid, "SIGTERM");
  } catch {
    return false;
  }
  if (await waitForPidExit(params.identity.pid, timeoutMs)) {
    return true;
  }
  const beforeSigkill = readCurrentIdentity();
  if (!beforeSigkill || !sameManagedChromeIdentity(params.identity, beforeSigkill)) {
    return false;
  }
  try {
    process.kill(params.identity.pid, "SIGKILL");
  } catch {
    return false;
  }
  return await waitForPidExit(params.identity.pid, CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS);
}

function clearRecoveredChromeSingletonArtifacts(
  userDataDir: string,
  pid: number,
  hostname = os.hostname(),
): boolean {
  if (isPidAlive(pid)) {
    return false;
  }
  // The stopped shell may have inherited a dead local full-Chromium lock.
  return (
    readSingletonLockTarget(userDataDir).status === "missing" ||
    clearStaleChromeSingletonLocks(userDataDir, hostname)
  );
}

async function recoverOwnedStaleManagedChromeCdpListener(params: {
  resolved: ResolvedBrowserConfig;
  profile: ResolvedBrowserProfile;
  userDataDir: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  params.signal?.throwIfAborted();
  if (!params.profile.cdpIsLoopback) {
    return false;
  }
  const lock = readSingletonLockTarget(params.userDataDir);
  if (unverifiedSingletonLockReason(lock)) {
    return false;
  }
  let diagnostic: ChromeCdpDiagnostic;
  try {
    diagnostic = await diagnoseChromeCdp(
      params.profile.cdpUrl,
      CHROME_REACHABILITY_TIMEOUT_MS,
      CHROME_WS_READY_TIMEOUT_MS,
      undefined,
      params.signal,
    );
  } catch {
    params.signal?.throwIfAborted();
    return false;
  }
  if (diagnostic.ok || diagnostic.code !== "websocket_health_command_timeout") {
    return false;
  }
  const owner = resolveOwnedManagedChromeListener({ ...params, lock });
  if (!owner) {
    return false;
  }
  const { exe, identity } = owner;
  const { pid } = identity;
  params.signal?.throwIfAborted();
  if (
    !(await terminateOwnedStaleChromeProcess({
      identity,
      exe,
      profile: params.profile,
      userDataDir: params.userDataDir,
    }))
  ) {
    return false;
  }
  if (!clearRecoveredChromeSingletonArtifacts(params.userDataDir, pid)) {
    return false;
  }
  log.warn(
    `Stopped stale managed Chrome CDP listener for profile "${params.profile.name}" (pid ${pid}) and retrying launch.`,
  );
  return true;
}

async function probeManagedChromePorts(
  profile: ResolvedBrowserProfile,
  signal?: AbortSignal,
): Promise<void> {
  const configuredHost = new URL(profile.cdpUrl).hostname.replace(/^\[|\]$/g, "");
  const probeHosts =
    configuredHost === "127.0.0.1" ? [configuredHost] : ["127.0.0.1", configuredHost];
  // Chromium tries IPv4 loopback first, while OpenClaw polls the configured endpoint.
  // Probe both so neither Chrome's bind nor the later readiness check can be captured.
  for (const host of probeHosts) {
    signal?.throwIfAborted();
    await ensurePortAvailable(profile.cdpPort, host);
  }
}

async function ensureManagedChromePortAvailable(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
  userDataDir: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await probeManagedChromePorts(profile, signal);
    return;
  } catch (err) {
    signal?.throwIfAborted();
    if (
      !isPortInUseError(err) ||
      !(await recoverOwnedStaleManagedChromeCdpListener({ resolved, profile, userDataDir, signal }))
    ) {
      throw err;
    }
  }
  await probeManagedChromePorts(profile, signal);
}

function chromeLaunchHints(params: {
  stderrOutput: string;
  stderrSignals?: ChromeLaunchStderrSignals;
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
  const missingDisplay =
    params.stderrSignals?.missingDisplay ??
    CHROME_MISSING_DISPLAY_PATTERN.test(params.stderrOutput);
  if (missingDisplay && !headlessMode.headless) {
    hints.push(
      "No DISPLAY/X server was detected. Set OPENCLAW_BROWSER_HEADLESS=1, remove the headed override, start Xvfb, or run the Gateway in a desktop session.",
    );
  }
  const singletonInUse =
    params.stderrSignals?.singletonInUse ??
    CHROME_SINGLETON_IN_USE_PATTERN.test(params.stderrOutput);
  if (singletonInUse) {
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
  graphicsDiagnostics?: BrowserGraphicsDiagnostics;
  graphicsDiagnosticsPending?: Promise<BrowserGraphicsDiagnostics>;
};

/** A managed child survived bounded cancellation and remains actor-owned for retry. */
export class ManagedChromeCleanupError extends Error {
  readonly code = "MANAGED_CHROME_CLEANUP_FAILED";

  constructor(
    message: string,
    readonly running: RunningChrome,
  ) {
    super(message);
    this.name = "ManagedChromeCleanupError";
  }
}

function resolveBrowserExecutable(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
  headless = resolveManagedBrowserHeadlessMode(resolved, profile).headless,
): BrowserExecutable | null {
  return resolveBrowserExecutableForPlatform(
    { ...resolved, headless, executablePath: profile.executablePath ?? resolved.executablePath },
    process.platform,
  );
}

/** Resolve the user-data-dir path for a managed OpenClaw Chrome profile. */
export function resolveOpenClawUserDataDir(profileName = DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME) {
  return path.join(CONFIG_DIR, "browser", profileName, "user-data");
}

/** Build Chrome launch arguments for the managed OpenClaw browser. */
function buildOpenClawChromeLaunchArgs(params: {
  resolved: ResolvedBrowserConfig;
  profile: ResolvedBrowserProfile;
  userDataDir: string;
  headlessOverride?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  useMockKeychain?: boolean;
}): string[] {
  const { resolved, profile, userDataDir } = params;
  const platform = params.platform ?? process.platform;
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

  if (platform === "darwin" && params.useMockKeychain) {
    // This is an isolated OpenClaw-owned profile, not the user's Chrome profile.
    // Keep its basic password store non-interactive so headless Chrome can
    // encrypt and persist cookies without login-keychain prompts.
    args.push("--use-mock-keychain");
  }
  if (headlessMode.headless) {
    args.push("--headless=new");
    args.push("--disable-gpu");
  }
  if (resolved.noSandbox) {
    args.push("--no-sandbox");
  }
  if (platform === "linux") {
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

type ChromeCdpEndpointPin = NonNullable<Awaited<ReturnType<typeof assertCdpEndpointAllowed>>>;

export type ChromeWebSocketEndpoint = {
  url: string;
  lookup?: ChromeCdpEndpointPin["lookup"];
};

async function canOpenWebSocket(
  url: string,
  timeoutMs: number,
  lookup?: ChromeCdpEndpointPin["lookup"],
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    return await withCdpSocket(url, async () => true, {
      handshakeTimeoutMs: timeoutMs,
      handshakeRetries: 0,
      lookup,
      signal,
    });
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

/** Return true when a Chrome CDP endpoint is reachable over HTTP. */
export async function isChromeReachable(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  try {
    const configuredPin = await assertCdpEndpointAllowed(cdpUrl, ssrfPolicy);
    signal?.throwIfAborted();
    if (isDirectCdpWebSocketEndpoint(cdpUrl)) {
      // Handshake-ready direct WS endpoint — probe via WS handshake.
      return await canOpenWebSocket(cdpUrl, timeoutMs, configuredPin?.lookup, signal);
    }
    // Either an http(s) discovery URL or a bare ws/wss root. Try
    // /json/version discovery first. For bare ws/wss URLs, fall back to a
    // direct WS handshake when discovery is unavailable — some providers
    // (e.g. Browserless/Browserbase) expose a direct WebSocket root without
    // a /json/version endpoint.
    const discoveryUrl = isWebSocketUrl(cdpUrl)
      ? normalizeCdpHttpBaseForJsonEndpoints(cdpUrl)
      : cdpUrl;
    const version = await fetchChromeVersion(discoveryUrl, timeoutMs, ssrfPolicy, signal);
    if (version) {
      return true;
    }
    if (isWebSocketUrl(cdpUrl)) {
      return await canOpenWebSocket(cdpUrl, timeoutMs, configuredPin?.lookup, signal);
    }
    return false;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

async function fetchChromeVersion(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
  signal?: AbortSignal,
): Promise<ChromeVersion | null> {
  try {
    return await readChromeVersionWithCredentialFallback(cdpUrl, timeoutMs, ssrfPolicy, signal);
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

/** Resolve a usable Chrome DevTools WebSocket endpoint from a CDP endpoint. */
export async function getChromeWebSocketEndpoint(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
  signal?: AbortSignal,
): Promise<ChromeWebSocketEndpoint | null> {
  signal?.throwIfAborted();
  const configuredPin = await assertCdpEndpointAllowed(cdpUrl, ssrfPolicy);
  signal?.throwIfAborted();
  const cdpControlPolicy = scopeCdpPolicyToConfiguredEndpoint(cdpUrl, ssrfPolicy);
  if (isDirectCdpWebSocketEndpoint(cdpUrl)) {
    // Handshake-ready direct WebSocket endpoint — the cdpUrl is already
    // the WebSocket URL.
    return { url: cdpUrl, lookup: configuredPin?.lookup };
  }
  // Either an http(s) endpoint or a bare ws/wss root; discover the
  // actual WebSocket URL via /json/version. Normalise the scheme so
  // fetch() can reach the endpoint.
  const discoveryUrl = isWebSocketUrl(cdpUrl)
    ? normalizeCdpHttpBaseForJsonEndpoints(cdpUrl)
    : cdpUrl;
  const version = await fetchChromeVersion(discoveryUrl, timeoutMs, cdpControlPolicy, signal);
  const wsUrl = normalizeOptionalString(version?.webSocketDebuggerUrl) ?? "";
  if (!wsUrl) {
    // /json/version unavailable or returned no WebSocket URL. For bare
    // ws/wss inputs, the URL itself may be a direct WebSocket endpoint
    // (e.g. Browserless/Browserbase-style providers without /json/version).
    // The SSRF check on cdpUrl was already performed at the start of this
    // function, so we can return it directly.
    if (isWebSocketUrl(cdpUrl)) {
      return { url: cdpUrl, lookup: configuredPin?.lookup };
    }
    return null;
  }
  const normalizedWsUrl = normalizeCdpWsUrl(wsUrl, discoveryUrl);
  const discoveredPin = await assertCdpEndpointAllowed(normalizedWsUrl, cdpControlPolicy, {
    source: "discovered",
    configuredUrl: cdpUrl,
  });
  signal?.throwIfAborted();
  return { url: normalizedWsUrl, lookup: discoveredPin?.lookup };
}

/** Return true when a Chrome CDP endpoint has a healthy WebSocket command path. */
export async function isChromeCdpReady(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  handshakeTimeoutMs = CHROME_WS_READY_TIMEOUT_MS,
  ssrfPolicy?: SsrFPolicy,
  options?: {
    signal?: AbortSignal;
    /** Record connection-owned facts before the ready result reaches route callers. */
    onDiagnostic?: (diagnostic: ChromeCdpDiagnostic) => void | Promise<void>;
  },
): Promise<boolean> {
  const diagnostic = await diagnoseChromeCdp(
    cdpUrl,
    timeoutMs,
    handshakeTimeoutMs,
    ssrfPolicy,
    options?.signal,
  );
  options?.signal?.throwIfAborted();
  if (!diagnostic.ok) {
    log.debug(formatChromeCdpDiagnostic(diagnostic));
  }
  await options?.onDiagnostic?.(diagnostic);
  options?.signal?.throwIfAborted();
  return diagnostic.ok;
}

type ManagedBrowserLaunchOptions = ManagedBrowserHeadlessOptions & { signal?: AbortSignal };

async function waitForManagedLaunchPoll(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  try {
    await delay(delayMs, undefined, signal ? { signal } : undefined);
  } catch (err) {
    signal?.throwIfAborted();
    throw err;
  }
}

/** Launch or attach to the managed OpenClaw Chrome profile. */
export async function launchOpenClawChrome(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
  launchOptions: ManagedBrowserLaunchOptions = {},
): Promise<RunningChrome> {
  launchOptions.signal?.throwIfAborted();
  if (!profile.cdpIsLoopback) {
    throw new Error(`Profile "${profile.name}" is remote; cannot launch local Chrome.`);
  }
  return await withChromeProfileLifecycleLock(profile.name, async () =>
    launchOpenClawChromeLocked(resolved, profile, launchOptions),
  );
}

async function launchOpenClawChromeLocked(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
  launchOptions: ManagedBrowserLaunchOptions,
): Promise<RunningChrome> {
  const { signal, ...headlessOptions } = launchOptions;
  signal?.throwIfAborted();
  const headlessMode = resolveManagedBrowserHeadlessMode(resolved, profile, headlessOptions);
  const missingDisplayError = getManagedBrowserMissingDisplayError(
    resolved,
    profile,
    headlessOptions,
  );
  if (missingDisplayError) {
    throw new BrowserProfileUnavailableError(missingDisplayError.message, {
      metadata: {
        reason: BROWSER_ERROR_REASONS.noDisplayForHeadedProfile,
        details: {
          profile: profile.name,
          requestedHeadless: false,
          headlessSource: missingDisplayError.headlessSource,
          displayPresent: false,
        },
      },
    });
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

  const userDataDir = resolveOpenClawUserDataDir(profile.name);
  await ensureManagedChromePortAvailable(resolved, profile, userDataDir, signal);
  signal?.throwIfAborted();

  const lock = readSingletonLockTarget(userDataDir);
  const lockReason =
    unverifiedSingletonLockReason(lock) ?? headlessShellProfileInUseReason(userDataDir);
  if (lockReason || (lock.status === "owner" && isPidAlive(lock.pid))) {
    throw new BrowserProfileUnavailableError(
      `Cannot start browser profile "${profile.name}": ${lockReason ?? "Chromium still holds its profile lock"}. ` +
        "Close the browser using this profile and check its lock before retrying.",
    );
  }

  const exe = resolveBrowserExecutable(resolved, profile, headlessMode.headless);
  if (!exe) {
    throw new Error(
      "No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).",
    );
  }

  assertBrowserExecutableSupportsLaunch(exe, headlessMode.headless, process.platform);
  fs.mkdirSync(userDataDir, { recursive: true });
  await ensureOutputDirectory(DEFAULT_DOWNLOAD_DIR);

  const localStatePath = path.join(userDataDir, "Local State");
  const preferencesPath = path.join(userDataDir, "Default", "Preferences");
  const profileIsNew = !fs.existsSync(localStatePath);
  const needsBootstrap =
    !headlessMode.headless && (profileIsNew || !fs.existsSync(preferencesPath));
  // Never change the encryption key source for an established profile: doing
  // so would make its existing cookies unreadable. New headless profiles opt in.
  const useMockKeychain =
    process.platform === "darwin" &&
    (usesOpenClawMockKeychain(userDataDir) || (profileIsNew && headlessMode.headless));

  const needsDecorate = !isProfileDecorated(
    userDataDir,
    profile.name,
    (profile.color ?? DEFAULT_OPENCLAW_BROWSER_COLOR).toUpperCase(),
    DEFAULT_DOWNLOAD_DIR,
  );

  // Headless profiles are seeded directly; headed profiles retain Chrome's first-run bootstrap.
  const spawnOnce = async (onStderr?: (chunk: Buffer | string) => void) => {
    signal?.throwIfAborted();
    const args = buildOpenClawChromeLaunchArgs({
      resolved,
      profile,
      userDataDir,
      ...headlessOptions,
      useMockKeychain,
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
    const preparedSpawn = prepareOomScoreAdjustedSpawn(exe.path, args, {
      env,
    });
    const proc = spawn(preparedSpawn.command, preparedSpawn.args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: preparedSpawn.env,
    });
    const onAbort = () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
    // Spawn and later kill failures arrive through EventEmitter. Keep this
    // listener for the whole child lifetime so neither path can crash Gateway.
    proc.on("error", (err) => {
      log.debug(`managed Chrome process error: ${redactToolPayloadText(String(err))}`);
    });
    if (onStderr) {
      proc.stderr?.on("data", onStderr);
    }
    if (proc.pid == null) {
      try {
        await once(proc, "spawn");
      } catch (err) {
        signal?.removeEventListener("abort", onAbort);
        if (onStderr) {
          proc.stderr?.off("data", onStderr);
        }
        throw err;
      }
    }
    const pid = proc.pid;
    if (pid == null) {
      signal?.removeEventListener("abort", onAbort);
      if (onStderr) {
        proc.stderr?.off("data", onStderr);
      }
      throw new Error("Managed Chrome process spawned without a pid.");
    }
    return {
      pid,
      proc,
      releaseAbort: () => signal?.removeEventListener("abort", onAbort),
    };
  };

  const startedAt = Date.now();
  const runningForProcess = (proc: ChildProcess, pid: number): RunningChrome => ({
    pid,
    exe,
    userDataDir,
    cdpPort: profile.cdpPort,
    startedAt,
    proc,
    headless: headlessMode.headless,
    headlessSource: headlessMode.source,
  });

  if (needsBootstrap) {
    const { pid: bootstrapPid, proc: bootstrap, releaseAbort } = await spawnOnce();
    let bootstrapError: Error | undefined;
    try {
      const deadline = Date.now() + CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (fs.existsSync(localStatePath) && fs.existsSync(preferencesPath)) {
          break;
        }
        await waitForManagedLaunchPoll(CHROME_BOOTSTRAP_PREFS_POLL_MS, signal);
      }
    } catch (err) {
      bootstrapError =
        err instanceof Error ? err : new Error("Managed Chrome bootstrap failed.", { cause: err });
    }
    let exited = await signalChromeProcess(bootstrap, "SIGTERM", CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS);
    if (!exited) {
      exited = await signalChromeProcess(bootstrap, "SIGKILL", CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS);
    }
    releaseAbort();
    if (!exited) {
      throw new ManagedChromeCleanupError(
        `Managed Chrome bootstrap ${bootstrapPid} survived cleanup.`,
        runningForProcess(bootstrap, bootstrapPid),
      );
    }
    if (bootstrapError) {
      throw bootstrapError;
    }
  }

  signal?.throwIfAborted();

  if (needsDecorate) {
    try {
      decorateOpenClawProfile(userDataDir, {
        name: profile.name,
        color: profile.color,
        downloadDir: DEFAULT_DOWNLOAD_DIR,
        mockKeychain: useMockKeychain,
      });
      log.info(`🦞 openclaw browser profile decorated (${profile.color})`);
    } catch (err) {
      log.warn(`openclaw browser profile decoration failed: ${String(err)}`);
    }
  }

  try {
    ensureProfileNetworkPredictionDisabled(userDataDir);
  } catch (err) {
    log.warn(`openclaw browser network-prediction prefs failed: ${String(err)}`);
  }

  try {
    ensureProfileCleanExit(userDataDir);
  } catch (err) {
    log.warn(`openclaw browser clean-exit prefs failed: ${String(err)}`);
  }
  signal?.throwIfAborted();

  const launchOnceAndWait = async (allowSingletonRecovery: boolean): Promise<RunningChrome> => {
    // Keep a bounded stderr tail for diagnostics in case Chrome fails to start.
    // Attach before awaiting spawn so immediate diagnostics cannot be lost.
    const stderrDiagnostics = createChromeLaunchStderrDiagnostics(
      CHROME_LAUNCH_STDERR_TAIL_MAX_BYTES,
    );
    const onStderr = (chunk: Buffer | string) => {
      stderrDiagnostics.append(chunk);
    };
    let proc: ChildProcess | undefined;
    let releaseSpawnAbort: (() => void) | undefined;

    try {
      const spawned = await spawnOnce(onStderr);
      proc = spawned.proc;
      releaseSpawnAbort = spawned.releaseAbort;
      const readyDeadline =
        Date.now() + (resolved.localLaunchTimeoutMs ?? CHROME_LAUNCH_READY_WINDOW_MS);
      let launchHttpReachable = false;
      // Full CDP WebSocket readiness is handled by the caller's
      // waitForCdpReadyAfterLaunch() budget; launch only owns process discovery.
      while (Date.now() < readyDeadline) {
        signal?.throwIfAborted();
        if (
          await isChromeReachable(
            profile.cdpUrl,
            MANAGED_CDP_READY_HTTP_TIMEOUT_MS,
            undefined,
            signal,
          )
        ) {
          launchHttpReachable = true;
          break;
        }
        await waitForManagedLaunchPoll(CHROME_LAUNCH_READY_POLL_MS, signal);
      }

      if (!launchHttpReachable) {
        signal?.throwIfAborted();
        let finalDiagnostic: ChromeCdpDiagnostic | null = null;
        let diagnosticErrorText: string | null = null;
        try {
          finalDiagnostic = await diagnoseChromeCdp(
            profile.cdpUrl,
            MANAGED_CDP_READY_HTTP_TIMEOUT_MS,
            CHROME_WS_READY_TIMEOUT_MS,
            undefined,
            signal,
          );
        } catch (err) {
          diagnosticErrorText = `CDP diagnostic failed: ${safeChromeCdpErrorMessage(err)}.`;
        }
        signal?.throwIfAborted();
        if (diagnosticShowsChromeHttpDiscovery(finalDiagnostic)) {
          launchHttpReachable = true;
        }
        const diagnosticText = finalDiagnostic
          ? formatChromeCdpDiagnostic(finalDiagnostic)
          : (diagnosticErrorText ?? "CDP diagnostic failed.");
        if (launchHttpReachable) {
          log.debug(diagnosticText);
        } else {
          const stderrOutput = normalizeOptionalString(stderrDiagnostics.toString()) ?? "";
          const stderrSignals = stderrDiagnostics.signals();
          const redactedStderrOutput = redactToolPayloadText(stderrOutput);
          if (
            allowSingletonRecovery &&
            stderrSignals.singletonInUse &&
            clearStaleChromeSingletonLocks(userDataDir)
          ) {
            log.warn(
              `Removed stale Chromium Singleton* locks for profile "${profile.name}" and retrying launch.`,
            );
            if (!(await terminateChromeForRetry(proc, userDataDir))) {
              throw new ManagedChromeCleanupError(
                `Managed Chrome process ${spawned.pid} survived singleton recovery.`,
                runningForProcess(proc, spawned.pid),
              );
            }
            releaseSpawnAbort();
            releaseSpawnAbort = undefined;
            return await launchOnceAndWait(false);
          }
          const stderrHint = redactedStderrOutput
            ? `\nChrome stderr:\n${sliceUtf16Safe(redactedStderrOutput, -CHROME_STDERR_HINT_MAX_CHARS)}`
            : "";
          const launchHints = chromeLaunchHints({
            stderrOutput,
            stderrSignals,
            resolved,
            profile,
            launchOptions: headlessOptions,
          });
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

      signal?.throwIfAborted();
      const pid = spawned.pid;
      log.info(
        `🦞 openclaw browser started (${exe.kind}) profile "${profile.name}" on 127.0.0.1:${profile.cdpPort} (pid ${pid})`,
      );

      return runningForProcess(proc, pid);
    } catch (err) {
      if (proc) {
        const pid = proc.pid;
        const exited = await signalChromeProcess(proc, "SIGKILL", CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS);
        if (!exited && typeof pid === "number") {
          throw new ManagedChromeCleanupError(
            `Managed Chrome process ${pid} survived launch cleanup.`,
            runningForProcess(proc, pid),
          );
        }
      }
      if (err instanceof ManagedChromeCleanupError) {
        if (err.running.proc !== proc) {
          throw err;
        }
        throw new Error(`${err.message} Exact child cleanup succeeded on retry.`, { cause: err });
      }
      throw err;
    } finally {
      // Chrome started successfully or launch failed — detach the stderr listener
      // and release the bounded tail buffer.
      releaseSpawnAbort?.();
      proc?.stderr?.off("data", onStderr);
      stderrDiagnostics.clear();
    }
  };

  return await launchOnceAndWait(true);
}

function cdpBrowserProcessId(result: unknown): number | null {
  if (!result || typeof result !== "object" || !("processInfo" in result)) {
    return null;
  }
  const processInfo = (result as { processInfo?: unknown }).processInfo;
  if (!Array.isArray(processInfo)) {
    return null;
  }
  const browser = processInfo.find((entry) => {
    const process = entry as { id?: unknown; type?: unknown } | null;
    return (
      process?.type === "browser" &&
      typeof process.id === "number" &&
      Number.isSafeInteger(process.id) &&
      process.id > 0
    );
  }) as { id?: number } | undefined;
  return browser?.id ?? null;
}

/** Read the mode of a browser process proven to own this host's loopback CDP port. */
export async function inspectLocalChromeHeadlessMode(params: {
  profile: ResolvedBrowserProfile;
  browserWebSocketUrl: string;
  timeoutMs: number;
  signal?: AbortSignal;
  ssrfPolicy?: SsrFPolicy;
}): Promise<boolean | undefined> {
  params.signal?.throwIfAborted();
  if (!params.profile.cdpIsLoopback) {
    return undefined;
  }
  try {
    const timeoutMs = Math.max(1, Math.min(params.timeoutMs, CHROME_WS_READY_TIMEOUT_MS));
    const directEndpoint =
      isDirectCdpWebSocketEndpoint(params.profile.cdpUrl) &&
      params.browserWebSocketUrl === params.profile.cdpUrl;
    const policy = directEndpoint
      ? params.ssrfPolicy
      : scopeCdpPolicyToConfiguredEndpoint(params.profile.cdpUrl, params.ssrfPolicy);
    const pin = await assertCdpEndpointAllowed(
      params.browserWebSocketUrl,
      policy,
      directEndpoint ? undefined : { source: "discovered", configuredUrl: params.profile.cdpUrl },
    );
    params.signal?.throwIfAborted();
    const result = await withCdpSocket(
      params.browserWebSocketUrl,
      async (send) => await send("SystemInfo.getProcessInfo"),
      {
        commandTimeoutMs: timeoutMs,
        handshakeRetries: 0,
        handshakeTimeoutMs: timeoutMs,
        lookup: pin?.lookup,
        signal: params.signal,
      },
    );
    params.signal?.throwIfAborted();
    const pid = cdpBrowserProcessId(result);
    if (!pid || !isPidAlive(pid) || !pidListensOnPort(pid, params.profile.cdpPort)) {
      return undefined;
    }
    const command = readManagedProcessCommandLine(pid);
    if (
      !command ||
      !processCommandHasFlag(command, "remote-debugging-port", String(params.profile.cdpPort))
    ) {
      return undefined;
    }
    return processCommandUsesHeadlessChrome(command);
  } catch {
    params.signal?.throwIfAborted();
    return undefined;
  }
}

/** Verify that a managed CDP endpoint belongs to the exact spawned browser pid. */
export async function isChromeCdpOwnedByPid(
  cdpUrl: string,
  pid: number,
  timeoutMs: number,
  ssrfPolicy?: SsrFPolicy,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  try {
    const endpoint = await getChromeWebSocketEndpoint(cdpUrl, timeoutMs, ssrfPolicy, signal);
    if (!endpoint) {
      return false;
    }
    const owned = await withCdpSocket(
      endpoint.url,
      async (send) => {
        signal?.throwIfAborted();
        return cdpBrowserProcessId(await send("SystemInfo.getProcessInfo")) === pid;
      },
      {
        commandTimeoutMs: timeoutMs,
        handshakeRetries: 0,
        handshakeTimeoutMs: timeoutMs,
        lookup: endpoint.lookup,
        signal,
      },
    );
    signal?.throwIfAborted();
    return owned;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

async function requestGracefulChromeClose(
  running: Pick<RunningChrome, "pid" | "cdpPort">,
  timeoutMs: number,
  ssrfPolicy?: SsrFPolicy,
  ownsCurrentProcess?: () => boolean,
): Promise<boolean> {
  const commandTimeoutMs = Math.max(
    1,
    Math.min(timeoutMs, CHROME_GRACEFUL_CLOSE_COMMAND_TIMEOUT_MS),
  );
  let commandSent = false;
  try {
    const endpoint = await getChromeWebSocketEndpoint(
      `http://127.0.0.1:${running.cdpPort}`,
      Math.min(commandTimeoutMs, CHROME_STOP_PROBE_TIMEOUT_MS),
      ssrfPolicy,
    );
    if (!endpoint) {
      return false;
    }
    await withCdpSocket(
      endpoint.url,
      async (send) => {
        // The fixed port can be rebound while this handle remains retained.
        // Never ask a replacement browser to close on behalf of the old child.
        const processInfo = await send("SystemInfo.getProcessInfo");
        if (
          cdpBrowserProcessId(processInfo) !== running.pid ||
          (ownsCurrentProcess && !ownsCurrentProcess())
        ) {
          return;
        }
        commandSent = true;
        await send("Browser.close");
      },
      {
        commandTimeoutMs,
        handshakeTimeoutMs: commandTimeoutMs,
        handshakeRetries: 0,
        lookup: endpoint.lookup,
      },
    );
    return commandSent;
  } catch (err) {
    log.debug(`Chrome graceful close skipped: ${safeChromeCdpErrorMessage(err)}`);
    // Chrome may close the socket before acknowledging Browser.close. Once the
    // command was sent, still give it time to flush the profile and exit.
    return commandSent;
  }
}

type ManagedChromeStopResult =
  | { status: "stopped" | "not-running" }
  | { status: "unverified"; reason: string };

async function managedChromeProfileReleaseReason(
  profile: ResolvedBrowserProfile,
  userDataDir: string,
): Promise<string | undefined> {
  try {
    await probeManagedChromePorts(profile);
  } catch {
    return "The Chromium CDP port is still occupied or could not be verified free";
  }
  // A changed profile port or a closing listener does not release shell data:
  // unlike full Chrome there is no singleton lock to expose its live writer.
  const shellReason = headlessShellProfileInUseReason(userDataDir);
  if (shellReason) {
    return shellReason;
  }
  const lock = readSingletonLockTarget(userDataDir);
  return (
    unverifiedSingletonLockReason(lock) ??
    (lock.status === "owner" && isPidAlive(lock.pid)
      ? "Chromium still holds the profile lock"
      : undefined)
  );
}

/** Stop only the exact managed Chrome owned by this profile across runtimes. */
export async function stopOwnedOpenClawChrome(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
  timeoutMs = CHROME_STOP_TIMEOUT_MS,
): Promise<ManagedChromeStopResult> {
  if (!profile.cdpIsLoopback || profile.attachOnly || profile.driver !== "openclaw") {
    return { status: "not-running" };
  }
  return await withChromeProfileLifecycleLock(profile.name, async () =>
    stopOwnedOpenClawChromeLocked(resolved, profile, timeoutMs),
  );
}

async function stopOwnedOpenClawChromeLocked(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
  timeoutMs: number,
): Promise<ManagedChromeStopResult> {
  const userDataDir = resolveOpenClawUserDataDir(profile.name);
  const lock = readSingletonLockTarget(userDataDir);
  const lockReason = unverifiedSingletonLockReason(lock);
  if (lockReason) {
    return { status: "unverified", reason: lockReason };
  }
  let owner: ReturnType<typeof resolveOwnedManagedChromeIdentity>;
  try {
    if (
      process.platform !== "linux" &&
      process.platform !== "darwin" &&
      [false, true].some((headless) => {
        const exe = resolveBrowserExecutable(resolved, profile, headless);
        return exe && isHeadlessShellExecutable(exe.path);
      })
    ) {
      return {
        status: "unverified",
        reason:
          "Cross-runtime headless shell cleanup is unsupported on this platform; use full Chromium for managed profiles",
      };
    }
    owner = resolveOwnedManagedChromeListener({ resolved, profile, userDataDir, lock });
  } catch {
    return { status: "unverified", reason: "Managed browser executable could not be resolved" };
  }
  if (!owner) {
    if (lock.status !== "owner" || !isPidAlive(lock.pid)) {
      const reason = await managedChromeProfileReleaseReason(profile, userDataDir);
      return reason ? { status: "unverified", reason } : { status: "not-running" };
    }
    return {
      status: "unverified",
      reason: "The active Chromium profile owner could not be verified",
    };
  }
  const { exe, identity } = owner;
  const { pid } = identity;

  // Browser runtimes do not share child handles; revalidate the exact process
  // before either CDP close or signal-based cleanup can affect a replacement.
  const gracefulCloseRequested = await requestGracefulChromeClose(
    { pid, cdpPort: profile.cdpPort },
    timeoutMs,
    resolved.ssrfPolicy,
    () => {
      const current = readOwnedManagedChromeIdentity({ pid, exe, profile, userDataDir });
      return current !== null && sameManagedChromeIdentity(identity, current);
    },
  );
  const stoppedGracefully = gracefulCloseRequested && (await waitForPidExit(pid, timeoutMs));
  if (
    !stoppedGracefully &&
    isPidAlive(pid) &&
    !(await terminateOwnedStaleChromeProcess({ identity, exe, profile, userDataDir }, timeoutMs))
  ) {
    return { status: "unverified", reason: "The Chromium profile owner changed or did not stop" };
  }
  clearRecoveredChromeSingletonArtifacts(userDataDir, pid);
  const remainingReason = await managedChromeProfileReleaseReason(profile, userDataDir);
  if (remainingReason) {
    return { status: "unverified", reason: remainingReason };
  }
  return { status: "stopped" };
}

/** Stop a managed Chrome process and wait for shutdown. */
export async function stopOpenClawChrome(
  running: RunningChrome,
  timeoutMs = CHROME_STOP_TIMEOUT_MS,
) {
  const proc = running.proc;
  // The fixed CDP port may already belong to a replacement. Once the
  // tracked child exits, never send Browser.close to the current listener.
  if (proc.exitCode != null || proc.signalCode != null) {
    return;
  }

  // Gateway shutdown/restart awaits the Browser plugin stop chain into this
  // method. Browser.close keeps cookies in Chromium's protected profile;
  // signals remain a bounded fallback without duplicating credentials.
  const gracefulCloseRequested = await requestGracefulChromeClose(running, timeoutMs);
  if (gracefulCloseRequested && (await waitForChromeProcessExit(proc, timeoutMs))) {
    return;
  }
  if (await signalChromeProcess(proc, "SIGTERM", timeoutMs)) {
    return;
  }

  if (!(await signalChromeProcess(proc, "SIGKILL", timeoutMs))) {
    throw new ManagedChromeCleanupError(
      `Managed Chrome process ${running.pid} survived shutdown.`,
      running,
    );
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
