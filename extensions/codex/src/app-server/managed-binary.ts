/**
 * Resolves the managed Codex app-server binary before stdio startup: a newer
 * user-installed Codex from PATH when it passes the version policy and an
 * app-server handshake, otherwise the package shipped beside the Codex plugin.
 */
import { constants as fsConstants } from "node:fs";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveNodeHostExecutable } from "openclaw/plugin-sdk/node-host";
import { canAccess } from "openclaw/plugin-sdk/path-existence-runtime";
import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { parse as parseSemver } from "semver";
import type { CodexAppServerStartOptions, CodexManagedCommandOrder } from "./config.js";
import { resolveMacOSDesktopCodexAppServerCommandCandidates } from "./desktop-app-paths.js";
import {
  installedCodex,
  type InstalledCodexAppServer,
  registeredCodexPlugin,
  resolveInstalledCodexLauncher,
  resolveManagedCodexAppServerCommandCandidates,
  isManagedCodexDesktopCommand,
} from "./managed-binary-paths.js";
import { CODEX_APP_SERVER_VERSION, MANAGED_CODEX_APP_SERVER_PACKAGE } from "./version.js";
export {
  resolveManagedCodexNativeCommand,
  resolvePackagedCodexNativeCommand,
  isManagedCodexDesktopCommand,
  setManagedCodexPluginRoot,
  resolveManagedCodexPackageEntrypoint,
} from "./managed-binary-paths.js";

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

type ResolveManagedCodexAppServerOptions = {
  platform?: NodeJS.Platform;
  pluginRoot?: string;
  /** False pins the shipped package, for callers that verify or mirror it. */
  preferInstalled?: boolean;
  /** Remaining allowance for installed selection, before bundled startup. */
  selectionTimeoutMs?: number;
};

/**
 * Version that managed starts with this command order report to ChatGPT model
 * discovery: the selected installed Codex, otherwise the bundled pin.
 */
export async function resolveManagedCodexClientVersion(
  order: CodexManagedCommandOrder,
  options: Pick<ResolveManagedCodexAppServerOptions, "platform" | "selectionTimeoutMs"> = {},
): Promise<string> {
  return (await resolveInstalledCodexForOrder(order, options))?.version ?? CODEX_APP_SERVER_VERSION;
}

/**
 * Desktop-first starts that find a macOS desktop app run it with the bundled
 * package as fallback; they never wait on, start, or report a PATH Codex.
 */
async function resolveInstalledCodexForOrder(
  order: CodexManagedCommandOrder,
  options: Pick<ResolveManagedCodexAppServerOptions, "platform" | "selectionTimeoutMs">,
): Promise<InstalledCodexAppServer | undefined> {
  const platform = options.platform ?? process.platform;
  if (order === "desktop-first") {
    for (const command of resolveMacOSDesktopCodexAppServerCommandCandidates(platform)) {
      if (await commandPathExists(command, platform)) {
        return undefined;
      }
    }
  }
  return resolveInstalledCodexAppServer(options.selectionTimeoutMs);
}

/**
 * Selects the installed Codex once per process; later callers reuse the decision.
 */
async function resolveInstalledCodexAppServer(
  timeoutMs = INSTALLED_CODEX_PROBE_TIMEOUT_MS,
): Promise<InstalledCodexAppServer | undefined> {
  if (!installedCodex.selection) {
    installedCodex.pending = true;
    const selection = decideInstalledCodexAppServer().then((decision) => {
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

async function decideInstalledCodexAppServer(): Promise<
  { found: string; selected: InstalledCodexAppServer } | { reason: string }
> {
  const env = process.env;
  const selectionDeadline = performance.now() + INSTALLED_CODEX_PROBE_TIMEOUT_MS;
  const found = resolveNodeHostExecutable("codex", { env, strategy: "direct" })?.executable;
  if (!found) {
    return { reason: "no codex on PATH" };
  }
  const launcher = resolveInstalledCodexLauncher(found, process.platform);
  if (!launcher) {
    return {
      reason: `installed ${found} is not a native Codex executable or the official ${MANAGED_CODEX_APP_SERVER_PACKAGE} launcher`,
    };
  }
  if (isManagedCodexDesktopCommand(launcher.command, process.platform)) {
    return { reason: `installed ${found} belongs to a macOS desktop app` };
  }
  let output: string;
  const versionTimeoutMs = Math.max(0, selectionDeadline - performance.now());
  if (versionTimeoutMs <= 0) {
    return { reason: `installed ${found} selection timed out before the version check` };
  }
  try {
    output = await runCodexVersionCommand(launcher.nativeCommand, process.env, versionTimeoutMs);
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
    // Lazy: the probe spawns through transport-stdio, which imports this module.
    handshakeVersion = await (
      await import("./installed-probe.js")
    ).probeCodexAppServerHandshake(launcher.command, handshakeTimeoutMs);
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
  const managedCommandOrder = startOptions.managedCommandOrder ?? "package-first";
  const installed =
    options.preferInstalled === false
      ? undefined
      : await resolveInstalledCodexForOrder(managedCommandOrder, {
          platform,
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
      (await commandPathExists(commandPath, platform)) &&
      (!isInstalled || (await commandPathExists(installed.nativeCommand, platform)))
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

async function commandPathExists(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  return canAccess(filePath, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
}
