// Runs child commands with process-group signal forwarding and Windows shell normalization.
import { spawn, spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "../windows-cmd-helpers.mjs";
import { resolveWindowsTaskkillPath } from "./windows-taskkill.mjs";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const FORCE_KILL_DELAY_MS = 5_000;
const MAX_MANAGED_COMMAND_TIMEOUT_MS = 2_147_000_000;
export const MANAGED_COMMAND_TIMEOUT_CODE = "OPENCLAW_MANAGED_COMMAND_TIMEOUT";
const managedChildren = new Set();
const signalHandlers = new Map();

/**
 * Return conventional shell exit code for a signal.
 *
 * @param {NodeJS.Signals} signal
 * @returns {number}
 */
export function signalExitCode(signal) {
  const signalNumber = signalNumberFor(signal);
  return signalNumber ? 128 + signalNumber : 1;
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals} [signal]
 * @param {{ platform?: NodeJS.Platform; runTaskkill?: typeof spawnSync }} [options]
 */
export function terminateManagedChild(
  child,
  signal = "SIGTERM",
  { platform = process.platform, runTaskkill = spawnSync } = {},
) {
  if (!child.pid) {
    return;
  }

  try {
    if (platform !== "win32") {
      process.kill(-child.pid, signal);
      return;
    }
  } catch (error) {
    if (!isMissingProcessError(error)) {
      try {
        child.kill(signal);
      } catch {
        // The process may have already exited between the group kill and fallback kill.
      }
    }
    return;
  }

  if (platform === "win32") {
    const taskkillPath = resolveWindowsTaskkillPath();
    const args = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") {
      args.push("/F");
    }
    const result = runTaskkill(taskkillPath, args, { stdio: "ignore" });
    if (!result?.error && result?.status === 0) {
      return;
    }
    if (signal !== "SIGKILL") {
      const forceResult = runTaskkill(taskkillPath, [...args, "/F"], { stdio: "ignore" });
      if (!forceResult?.error && forceResult?.status === 0) {
        return;
      }
    }
  }

  child.kill(signal);
}

/**
 * Run a child command while forwarding termination signals to the managed process group.
 *
 * @param {{
 *   bin: string;
 *   args?: string[];
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 *   stdio?: import("node:child_process").StdioOptions;
 *   shell?: boolean;
 *   windowsVerbatimArguments?: boolean;
 *   platform?: NodeJS.Platform;
 *   comSpec?: string;
 *   onReady?: (child: import("node:child_process").ChildProcess) => void;
 *   timeoutMs?: number;
 * }} options
 * @returns {Promise<number>}
 */
export async function runManagedCommand({
  bin,
  args = [],
  cwd,
  env,
  stdio = "inherit",
  platform = process.platform,
  shell = platform === "win32",
  windowsVerbatimArguments,
  comSpec,
  onReady,
  timeoutMs,
}) {
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_MANAGED_COMMAND_TIMEOUT_MS)
  ) {
    throw new TypeError(
      `managed command timeoutMs must be a positive integer no greater than ${MAX_MANAGED_COMMAND_TIMEOUT_MS}`,
    );
  }
  const spawnSpec = createManagedCommandSpawnSpec({
    bin,
    args,
    cwd,
    env,
    stdio,
    shell,
    windowsVerbatimArguments,
    platform,
    comSpec,
  });
  const child = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
  const managedChild = {
    child,
    forceKillTimer: null,
    receivedSignal: null,
    timedOut: false,
  };
  addManagedChild(managedChild);
  onReady?.(child);
  const timeoutTimer =
    timeoutMs === undefined
      ? null
      : setTimeout(() => {
          managedChild.timedOut = true;
          terminateManagedChild(child, "SIGTERM", { platform });
          managedChild.forceKillTimer ??= setTimeout(() => {
            terminateManagedChild(child, "SIGKILL", { platform });
          }, FORCE_KILL_DELAY_MS);
        }, timeoutMs);

  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        if (managedChild.forceKillTimer) {
          clearTimeout(managedChild.forceKillTimer);
        }
        if (managedChild.receivedSignal || managedChild.timedOut) {
          terminateManagedChild(child, "SIGKILL", { platform });
        }
        if (managedChild.timedOut) {
          const error = new Error(`managed command timed out after ${timeoutMs}ms`);
          error.code = MANAGED_COMMAND_TIMEOUT_CODE;
          error.timeoutMs = timeoutMs;
          reject(error);
          return;
        }
        resolve(
          managedChild.receivedSignal
            ? signalExitCode(managedChild.receivedSignal)
            : signal
              ? signalExitCode(signal)
              : (status ?? 1),
        );
      });
    });
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    if (managedChild.forceKillTimer) {
      clearTimeout(managedChild.forceKillTimer);
    }
    removeManagedChild(managedChild);
  }
}

/**
 * Build the spawn command, args, and options used by managed command execution.
 *
 * @param {{
 *   child: import("node:child_process").ChildProcess;
 *   forceKillTimer: ReturnType<typeof setTimeout> | null;
 *   receivedSignal: string | null;
 *   timedOut: boolean;
 * }} managedChild
 */
function addManagedChild(managedChild) {
  managedChildren.add(managedChild);
  installSignalHandlers();
}

/**
 * Build a normalized command invocation, including cmd.exe wrapping on Windows.
 *
 * @param {{
 *   child: import("node:child_process").ChildProcess;
 *   forceKillTimer: ReturnType<typeof setTimeout> | null;
 *   receivedSignal: string | null;
 *   timedOut: boolean;
 * }} managedChild
 */
function removeManagedChild(managedChild) {
  managedChildren.delete(managedChild);
  if (managedChildren.size === 0) {
    removeSignalHandlers();
  }
}

function installSignalHandlers() {
  for (const signal of FORWARDED_SIGNALS) {
    if (signalHandlers.has(signal)) {
      continue;
    }
    const handler = () => forwardSignalToManagedChildren(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function removeSignalHandlers() {
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
  signalHandlers.clear();
}

/**
 * @param {NodeJS.Signals} signal
 */
function forwardSignalToManagedChildren(signal) {
  for (const managedChild of managedChildren) {
    managedChild.receivedSignal ??= signal;
    terminateManagedChild(managedChild.child, signal);
    managedChild.forceKillTimer ??= setTimeout(() => {
      terminateManagedChild(managedChild.child, "SIGKILL");
    }, FORCE_KILL_DELAY_MS);
  }
}

/**
 * @param {{
 *   bin: string;
 *   args?: string[];
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 *   stdio?: import("node:child_process").StdioOptions;
 *   shell?: boolean;
 *   windowsVerbatimArguments?: boolean;
 *   platform?: NodeJS.Platform;
 *   comSpec?: string;
 * }} options
 */
export function createManagedCommandSpawnSpec({
  bin,
  args = [],
  cwd,
  env,
  stdio = "inherit",
  platform = process.platform,
  shell = platform === "win32",
  windowsVerbatimArguments,
  comSpec,
}) {
  const invocation = createManagedCommandInvocation({
    bin,
    args,
    env,
    shell,
    windowsVerbatimArguments,
    platform,
    comSpec,
  });

  return {
    args: invocation.args,
    command: invocation.command,
    options: {
      cwd,
      env,
      stdio,
      shell: invocation.shell,
      detached: platform !== "win32",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    },
  };
}

/**
 * @param {{
 *   bin: string;
 *   args?: string[];
 *   env?: NodeJS.ProcessEnv;
 *   shell?: boolean;
 *   windowsVerbatimArguments?: boolean;
 *   platform?: NodeJS.Platform;
 *   comSpec?: string;
 * }} options
 */
export function createManagedCommandInvocation({
  bin,
  args = [],
  env,
  platform = process.platform,
  shell = platform === "win32",
  windowsVerbatimArguments,
  comSpec,
}) {
  if (platform === "win32" && shell && args.length > 0) {
    return {
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(bin, args)],
      command: comSpec ?? resolveWindowsCmdExePath(env ?? process.env),
      shell: false,
      windowsVerbatimArguments: true,
    };
  }

  return {
    args,
    command: bin,
    shell,
    windowsVerbatimArguments,
  };
}

function signalNumberFor(signal) {
  switch (signal) {
    case "SIGHUP":
      return 1;
    case "SIGINT":
      return 2;
    case "SIGTERM":
      return 15;
    default:
      return osConstants.signals?.[signal] ?? 0;
  }
}

function isMissingProcessError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
}
