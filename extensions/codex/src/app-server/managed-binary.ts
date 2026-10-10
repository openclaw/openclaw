/**
 * Resolves the managed Codex app-server binary before stdio startup: a newer
 * user-installed Codex from PATH when it passes the version policy and an
 * app-server handshake, otherwise the package shipped beside the Codex plugin.
 */
import { constants as fsConstants, existsSync, realpathSync } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { resolveNodeHostExecutable } from "openclaw/plugin-sdk/node-host";
import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { parse as parseSemver } from "semver";
import type { CodexAppServerStartOptions, CodexManagedCommandOrder } from "./config.js";
import { resolveMacOSDesktopCodexAppServerCommandCandidates } from "./desktop-app-paths.js";
import { CODEX_APP_SERVER_VERSION, MANAGED_CODEX_APP_SERVER_PACKAGE } from "./version.js";

export const CODEX_VERSION_TIMEOUT_MS = 5_000;
const CODEX_VERSION_MAX_OUTPUT_BYTES = 64 * 1024;
// The complete cold selection must leave room for bundled startup within the
// default ten-second catalog deadline, including both version and initialize.
export const INSTALLED_CODEX_PROBE_TIMEOUT_MS = 4_000;
/**
 * Initialize allowance for a managed start of the already-probed installed
 * Codex while the bundled fallback remains; short enough that the fallback
 * fits the 10 second model-catalog deadline.
 */
export const INSTALLED_CODEX_START_TIMEOUT_MS = 4_000;

// Mirrors the official launcher; native startup remains owned by its npm entrypoint.
const NATIVE_TARGET_TRIPLES = new Map([
  ["linux-x64", "x86_64-unknown-linux-musl"],
  ["linux-arm64", "aarch64-unknown-linux-musl"],
  ["darwin-x64", "x86_64-apple-darwin"],
  ["darwin-arm64", "aarch64-apple-darwin"],
  ["win32-x64", "x86_64-pc-windows-msvc"],
  ["win32-arm64", "aarch64-pc-windows-msvc"],
]);

// Registration and lazy runtime artifacts can load separate module copies.
// They must resolve dependencies from the same loader-owned plugin root.
const registeredCodexPlugin = resolveGlobalSingleton<{ root?: string }>(
  Symbol.for("openclaw.codexManagedPluginRoot"),
  () => ({}),
);

type ResolveManagedCodexAppServerOptions = {
  platform?: NodeJS.Platform;
  pluginRoot?: string;
  pathExists?: (filePath: string, platform: NodeJS.Platform) => Promise<boolean>;
  /** False pins the shipped package, for callers that verify or mirror it. */
  preferInstalled?: boolean;
  /** Remaining allowance for installed selection, before bundled startup. */
  selectionTimeoutMs?: number;
};

/** A user-installed Codex that passed the version policy and an app-server handshake. */
export type InstalledCodexAppServer = {
  command: string;
  nativeCommand: string;
  version: string;
};

type InstalledCodexAppServerState = {
  selection?: Promise<InstalledCodexAppServer | undefined>;
  pending?: boolean;
  selected?: InstalledCodexAppServer;
  /** Launcher dropped after a failed start; concurrent starts of it still fall back. */
  rejected?: string;
};

// One decision per process, so model discovery and every managed start agree on
// the binary. A Gateway restart drains the slot and the next start re-resolves.
const installedCodex = resolveGlobalSingleton<InstalledCodexAppServerState>(
  Symbol.for("openclaw.codexInstalledAppServer"),
  () => ({}),
  (state) => {
    delete state.selection;
    delete state.selected;
    delete state.pending;
    delete state.rejected;
  },
);

type InstalledCodexAppServerProbes = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runVersion?: (nativeCommand: string) => Promise<string>;
  probeHandshake?: (command: string) => Promise<string | undefined>;
};

type ResolveManagedCodexNativeCommandOptions = {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  pathExists?: (filePath: string) => boolean;
  resolvePackageJson?: (packageName: string, root: string) => string | undefined;
};

/** Records the process-stable plugin root prepared by OpenClaw's plugin loader. */
export function setManagedCodexPluginRoot(pluginRoot: string | undefined): void {
  registeredCodexPlugin.root = pluginRoot;
}

/**
 * Version that managed starts with this command order report to ChatGPT model
 * discovery: the selected installed Codex, otherwise the bundled pin.
 */
export async function resolveManagedCodexClientVersion(
  order: CodexManagedCommandOrder,
  options: Pick<
    ResolveManagedCodexAppServerOptions,
    "platform" | "pathExists" | "selectionTimeoutMs"
  > & {
    probes?: InstalledCodexAppServerProbes;
  } = {},
): Promise<string> {
  return (await resolveInstalledCodexForOrder(order, options))?.version ?? CODEX_APP_SERVER_VERSION;
}

/**
 * Desktop-first starts that find a macOS desktop app run it with the bundled
 * package as fallback; they never wait on, start, or report a PATH Codex.
 */
async function resolveInstalledCodexForOrder(
  order: CodexManagedCommandOrder,
  options: Pick<
    ResolveManagedCodexAppServerOptions,
    "platform" | "pathExists" | "selectionTimeoutMs"
  > & {
    probes?: InstalledCodexAppServerProbes;
  },
): Promise<InstalledCodexAppServer | undefined> {
  const platform = options.platform ?? process.platform;
  const pathExists = options.pathExists ?? commandPathExists;
  if (order === "desktop-first") {
    for (const command of resolveMacOSDesktopCodexAppServerCommandCandidates(platform)) {
      if (await pathExists(command, platform)) {
        return undefined;
      }
    }
  }
  return resolveInstalledCodexAppServer(options.probes, options.selectionTimeoutMs);
}

/**
 * Selects the installed Codex once per process; later callers reuse the
 * decision, so probes only apply to the call that makes it.
 */
async function resolveInstalledCodexAppServer(
  probes: InstalledCodexAppServerProbes = {},
  timeoutMs = INSTALLED_CODEX_PROBE_TIMEOUT_MS,
): Promise<InstalledCodexAppServer | undefined> {
  if (!installedCodex.selection) {
    installedCodex.pending = true;
    const selection = decideInstalledCodexAppServer(probes).then((decision) => {
      if (installedCodex.selection !== selection) {
        return undefined;
      }
      delete installedCodex.pending;
      embeddedAgentLog.info(
        "selected" in decision
          ? `Codex app-server: using installed ${decision.found} ${decision.selected.version} (newer than bundled ${CODEX_APP_SERVER_VERSION})`
          : `Codex app-server: using bundled ${CODEX_APP_SERVER_VERSION} (${decision.reason})`,
      );
      if ("selected" in decision) {
        installedCodex.selected = decision.selected;
        return decision.selected;
      }
      return undefined;
    });
    installedCodex.selection = selection;
  }
  const selection = installedCodex.selection;
  if (!installedCodex.pending) {
    return selection;
  }
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(
      () => {
        if (installedCodex.selection === selection) {
          installedCodex.selection = Promise.resolve(undefined);
          delete installedCodex.pending;
          embeddedAgentLog.info(
            `Codex app-server: using bundled ${CODEX_APP_SERVER_VERSION} (installed Codex selection exceeded its startup budget)`,
          );
        }
        resolve(undefined);
      },
      Math.min(timeoutMs, INSTALLED_CODEX_PROBE_TIMEOUT_MS),
    );
  });
  try {
    return await Promise.race([selection, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drops the selected installed Codex after it failed to start, so this process
 * uses the bundled package until the Gateway restarts. Returns true for that
 * launcher, including starts that captured it before another start dropped it,
 * and false for any other command. Only the first failure is logged.
 */
export function rejectInstalledCodexAppServer(command: string, error: unknown): boolean {
  const selected = installedCodex.selected;
  if (selected?.command !== command) {
    return installedCodex.rejected === command;
  }
  installedCodex.rejected = command;
  installedCodex.selection = Promise.resolve(undefined);
  delete installedCodex.selected;
  embeddedAgentLog.warn(
    `Codex app-server: installed ${command} ${selected.version} failed to start (${coerceErrorMessage(error)}); using bundled ${CODEX_APP_SERVER_VERSION} until the Gateway restarts`,
  );
  return true;
}

/**
 * Rejects an initialize answer from the selected installed Codex that names
 * another version, and any start of a launcher another start already rejected.
 */
export function assertInstalledCodexAppServerVersion(
  command: string,
  serverVersion: string | undefined,
): void {
  const selected = installedCodex.selected;
  if (selected?.command === command && serverVersion !== selected.version) {
    throw new Error(`app-server reported ${serverVersion ?? "no version"}`);
  }
  if (selected?.command !== command && installedCodex.rejected === command) {
    throw new Error("another start already rejected this installed Codex");
  }
}

/** Whether `command` is this process's selected installed Codex, or was until it failed. */
export function readInstalledCodexAppServerStatus(
  command: string,
): "selected" | "rejected" | undefined {
  if (installedCodex.selected?.command === command) {
    return "selected";
  }
  return installedCodex.rejected === command ? "rejected" : undefined;
}

async function decideInstalledCodexAppServer(
  probes: InstalledCodexAppServerProbes,
): Promise<{ found: string; selected: InstalledCodexAppServer } | { reason: string }> {
  const env = probes.env ?? process.env;
  const platform = probes.platform ?? process.platform;
  const selectionDeadline = performance.now() + INSTALLED_CODEX_PROBE_TIMEOUT_MS;
  const found = resolveNodeHostExecutable("codex", { env, strategy: "direct" })?.executable;
  if (!found) {
    return { reason: "no codex on PATH" };
  }
  const launcher = await resolveInstalledCodexLauncher(found, platform);
  if (!launcher) {
    return {
      reason: `installed ${found} is not a native Codex executable or the official ${MANAGED_CODEX_APP_SERVER_PACKAGE} launcher`,
    };
  }
  if (isManagedCodexDesktopCommand(launcher.command, platform)) {
    return { reason: `installed ${found} belongs to a macOS desktop app` };
  }
  let output: string;
  const versionTimeoutMs = Math.max(0, selectionDeadline - performance.now());
  if (versionTimeoutMs <= 0) {
    return { reason: `installed ${found} selection timed out before the version check` };
  }
  try {
    output = probes.runVersion
      ? await probes.runVersion(launcher.nativeCommand)
      : await runCodexVersionCommand(launcher.nativeCommand, process.env, versionTimeoutMs);
  } catch (error) {
    return { reason: `installed ${found} --version failed: ${coerceErrorMessage(error)}` };
  }
  const version = parseCodexVersion(output);
  const parsed = version ? parseSemver(version) : null;
  if (!version || !parsed) {
    return { reason: `installed ${found} did not report a parseable version` };
  }
  const bundled = parseSemver(CODEX_APP_SERVER_VERSION)!;
  if (parsed.compare(bundled) <= 0) {
    return { reason: `installed ${found} ${version} is not newer` };
  }
  if (parsed.prerelease.length > 0) {
    return { reason: `installed ${found} ${version} is a prerelease` };
  }
  // App-server has no negotiated protocol version; a major bump is Codex's
  // signal that OpenClaw's generated client may no longer match.
  if (parsed.major !== bundled.major) {
    return { reason: `installed ${found} ${version} is a different major version` };
  }
  const handshakeTimeoutMs = Math.max(0, selectionDeadline - performance.now());
  if (handshakeTimeoutMs <= 0) {
    return { reason: `installed ${found} selection timed out before the app-server handshake` };
  }
  let handshakeVersion: string | undefined;
  try {
    handshakeVersion = await (
      probes.probeHandshake ??
      // Lazy: the probe spawns through transport-stdio, which imports this module.
      (async (command) =>
        (await import("./installed-probe.js")).probeCodexAppServerHandshake(
          command,
          handshakeTimeoutMs,
        ))
    )(launcher.command);
  } catch (error) {
    return {
      reason: `installed ${found} ${version} failed the app-server handshake: ${coerceErrorMessage(error)}`,
    };
  }
  if (handshakeVersion !== version) {
    return {
      reason: `installed ${found} ${version} reported ${handshakeVersion ?? "no version"} from app-server`,
    };
  }
  return { found, selected: { ...launcher, version } };
}

/** Accepts native executables and the official npm launcher, never other script wrappers. */
async function resolveInstalledCodexLauncher(
  found: string,
  platform: NodeJS.Platform,
): Promise<{ command: string; nativeCommand: string } | undefined> {
  let command: string;
  try {
    command = await realpath(found);
    if (platform === "win32" && /\.(?:cmd|bat|ps1)$/iu.test(command)) {
      // npm's Windows shims sit beside the global node_modules directory.
      command = await realpath(
        path.join(path.dirname(command), "node_modules", "@openai", "codex", "bin", "codex.js"),
      );
    }
  } catch {
    return undefined;
  }
  const packagedNative = resolvePackagedCodexNativeCommand(command);
  if (packagedNative) {
    return { command, nativeCommand: packagedNative };
  }
  if (/\.(?:[cm]?js|cmd|bat|ps1)$/iu.test(command) || (await startsWithShebang(command))) {
    return undefined;
  }
  return { command, nativeCommand: command };
}

async function startsWithShebang(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r").catch(() => undefined);
  if (!handle) {
    return true;
  }
  try {
    const buffer = Buffer.alloc(2);
    const { bytesRead } = await handle.read(buffer, 0, 2, 0);
    return bytesRead === 2 && buffer.toString("latin1") === "#!";
  } finally {
    await handle.close();
  }
}

/** Extracts the semver from `codex --version` output such as `codex-cli 0.160.0`. */
export function parseCodexVersion(output: string): string | undefined {
  return /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s|$)/u.exec(
    output,
  )?.[1];
}

/** Runs `<native> --version` with bounded time and output; returns stdout and stderr. */
export async function runCodexVersionCommand(
  nativeCommand: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = CODEX_VERSION_TIMEOUT_MS,
): Promise<string> {
  const result = await runUtf8CommandWithTimeout([nativeCommand, "--version"], {
    baseEnv: env,
    input: "",
    timeoutMs,
    maxOutputBytes: CODEX_VERSION_MAX_OUTPUT_BYTES,
    outputCapture: "head",
    terminateOnOutputLimit: true,
    killProcessTree: true,
    killSignal: "SIGKILL",
    killGraceMs: 0,
  });
  if (result.termination !== "exit" || result.code !== 0 || result.outputLimitExceeded) {
    throw new Error(
      result.outputLimitExceeded
        ? "Version output exceeded its capture limit"
        : result.termination === "timeout"
          ? `Version check timed out after ${timeoutMs} ms`
          : `Version check failed (${result.signal ?? result.code ?? result.termination})`,
    );
  }
  return `${result.stdout}\n${result.stderr}`;
}

export async function resolveManagedCodexAppServerStartOptions(
  startOptions: CodexAppServerStartOptions,
  options: ResolveManagedCodexAppServerOptions = {},
): Promise<CodexAppServerStartOptions> {
  if (startOptions.transport !== "stdio" || startOptions.commandSource !== "managed") {
    return startOptions;
  }

  const pluginRoot = options.pluginRoot ?? registeredCodexPlugin.root;
  if (!pluginRoot) {
    throw new Error(
      "Codex plugin root is unavailable. Load the Codex plugin before starting its managed app-server.",
    );
  }
  const platform = options.platform ?? process.platform;
  const pathExists = options.pathExists ?? commandPathExists;
  const managedCommandOrder = startOptions.managedCommandOrder ?? "package-first";
  const installed =
    options.preferInstalled === false
      ? undefined
      : await resolveInstalledCodexForOrder(managedCommandOrder, {
          platform,
          pathExists,
          selectionTimeoutMs: options.selectionTimeoutMs,
        });
  const candidateCommandPaths = resolveManagedCodexAppServerCommandCandidates(
    pluginRoot,
    platform,
    managedCommandOrder,
    installed?.command,
  );
  const commandPaths: string[] = [];
  for (const commandPath of candidateCommandPaths) {
    const isInstalled = commandPath === installed?.command;
    if (
      (await pathExists(commandPath, platform)) &&
      (!isInstalled || (await pathExists(installed.nativeCommand, platform)))
    ) {
      commandPaths.push(commandPath);
    } else if (isInstalled) {
      // Removed after selection: discovery must stop reporting its version too.
      rejectInstalledCodexAppServer(commandPath, new Error("executable is no longer available"));
    }
  }
  const [commandPath, ...managedFallbackCommandPaths] = commandPaths;
  if (commandPath === undefined) {
    throw new Error(
      [
        `Managed Codex app-server binary was not found for ${MANAGED_CODEX_APP_SERVER_PACKAGE}.`,
        "Reinstall or update OpenClaw, or run pnpm install in a source checkout.",
        "Set plugins.entries.codex.config.appServer.command or OPENCLAW_CODEX_APP_SERVER_BIN to use a custom Codex binary.",
      ].join(" "),
    );
  }

  return {
    ...startOptions,
    command: commandPath,
    commandSource: "resolved-managed",
    ...(managedFallbackCommandPaths.length > 0 ? { managedFallbackCommandPaths } : {}),
  };
}

/** Resolves the native artifact behind a successful managed launcher selection. */
export function resolveManagedCodexNativeCommand(
  command: string,
  options: ResolveManagedCodexNativeCommandOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const installedNative = installedCodex.selected;
  if (installedNative?.command === command) {
    return installedNative.nativeCommand;
  }
  if (isManagedCodexDesktopCommand(command, platform)) {
    return command;
  }
  const target = `${platform === "android" ? "linux" : platform}-${options.arch ?? process.arch}`;
  const triple = NATIVE_TARGET_TRIPLES.get(target);
  if (!triple) {
    return undefined;
  }
  const packageRoot = resolveManagedCodexPackageRootForCommand(command, platform);
  if (!packageRoot) {
    return undefined;
  }
  const resolvePackageJson = options.resolvePackageJson ?? resolvePackageJsonFromRoot;
  const pathExists = options.pathExists ?? existsSync;
  // The npm entrypoint selects the platform package before checking its binary.
  // An incomplete platform package must not attest a different embedded executable.
  const packageJsonPath =
    resolvePackageJson(`@openai/codex-${target}`, packageRoot) ??
    resolvePackageJson(MANAGED_CODEX_APP_SERVER_PACKAGE, packageRoot);
  if (!packageJsonPath) {
    return undefined;
  }
  const candidate = path.join(
    path.dirname(packageJsonPath),
    "vendor",
    triple,
    "bin",
    platform === "win32" ? "codex.exe" : "codex",
  );
  return pathExists(candidate) ? candidate : undefined;
}

/** Recognizes only the official npm entrypoint, not arbitrary configured wrappers. */
export function resolvePackagedCodexNativeCommand(entrypoint: string): string | undefined {
  const packageRoot = path.dirname(path.dirname(entrypoint));
  if (
    path.basename(packageRoot) !== "codex" ||
    path.basename(path.dirname(packageRoot)) !== "@openai" ||
    path.relative(packageRoot, entrypoint) !== path.join("bin", "codex.js")
  ) {
    return undefined;
  }
  return resolveManagedCodexNativeCommand(entrypoint);
}

export function isManagedCodexDesktopCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === "darwin" &&
    resolveMacOSDesktopCodexAppServerCommandCandidates(platform).includes(command)
  );
}

function resolveManagedCodexPackageRootForCommand(
  command: string,
  platform: NodeJS.Platform,
): string | undefined {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const commandPaths = [command];
  try {
    commandPaths.unshift(realpathSync(command));
  } catch {
    // Lexical .bin shims still identify their adjacent package root.
  }
  for (const commandPath of commandPaths) {
    let current = pathApi.dirname(commandPath);
    while (true) {
      if (
        pathApi.basename(current) === "codex" &&
        pathApi.basename(pathApi.dirname(current)) === "@openai"
      ) {
        return current;
      }
      if (pathApi.basename(current) === ".bin") {
        return pathApi.join(pathApi.dirname(current), "@openai", "codex");
      }
      const parent = pathApi.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return undefined;
}

function resolvePackageJsonFromRoot(packageName: string, root: string): string | undefined {
  try {
    const manifestPath = realpathSync(path.join(root, "package.json"));
    return createRequire(manifestPath).resolve(`${packageName}/package.json`);
  } catch {
    return undefined;
  }
}

function resolveManagedCodexAppServerCommandCandidates(
  pluginRoot: string,
  platform: NodeJS.Platform,
  managedCommandOrder: CodexManagedCommandOrder,
  installedCommand: string | undefined,
): string[] {
  const packageCommand = resolveManagedCodexPackageEntrypoint(pluginRoot);
  // A newer installed Codex replaces the pinned package as the primary choice;
  // the package stays next as the fallback for a failed first start.
  const packageCommandPaths = [installedCommand, packageCommand].filter(
    (command): command is string => command !== undefined,
  );
  if (managedCommandOrder === "package-only") {
    return packageCommandPaths;
  }
  const desktopCommandPaths = resolveMacOSDesktopCodexAppServerCommandCandidates(platform);
  // Ordinary turns prefer the package selection. Computer Use opts into the
  // desktop app owner because its macOS TCC permissions live there.
  return managedCommandOrder === "desktop-first"
    ? [...desktopCommandPaths, ...packageCommandPaths]
    : [...packageCommandPaths, ...desktopCommandPaths];
}

export function resolveManagedCodexPackageEntrypoint(pluginRoot: string): string | undefined {
  try {
    // Use the pinned package's official launcher on every OS. It owns platform
    // selection, manager environment markers, signal forwarding, and exit status.
    return createRequire(path.join(pluginRoot, "package.json")).resolve(
      `${MANAGED_CODEX_APP_SERVER_PACKAGE}/bin/codex.js`,
    );
  } catch {
    return undefined;
  }
}

async function commandPathExists(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(filePath, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
