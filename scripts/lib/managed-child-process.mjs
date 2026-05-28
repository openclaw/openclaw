import { spawn, spawnSync } from "node:child_process";
import { extname } from "node:path";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const FORCE_KILL_DELAY_MS = 5_000;

/**
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
 */
function terminateManagedChild(child, signal = "SIGTERM") {
  if (!child.pid) {
    return;
  }

  try {
    if (process.platform !== "win32") {
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

  if (process.platform === "win32") {
    try {
      const taskkillArgs = [
        ...(signal === "SIGKILL" ? ["/F"] : []),
        "/T",
        "/PID",
        String(child.pid),
      ];
      const result = spawnSync("taskkill", taskkillArgs, {
        stdio: "ignore",
        windowsHide: true,
      });
      if (!result.error && result.status === 0) {
        return;
      }
    } catch {
      // Fall back to direct process termination below.
    }
  }

  child.kill(signal);
}

/**
 * @param {{
 *   bin: string;
 *   args?: string[];
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 *   stdio?: import("node:child_process").StdioOptions;
 *   shell?: boolean;
 *   onReady?: (child: import("node:child_process").ChildProcess) => void;
 * }} options
 * @returns {Promise<number>}
 */
export async function runManagedCommand({
  bin,
  args = [],
  cwd,
  env,
  stdio = "inherit",
  shell = shouldUseManagedCommandShell(bin),
  onReady,
}) {
  const child = spawn(bin, args, {
    cwd,
    env,
    stdio,
    shell,
    detached: process.platform !== "win32",
  });

  let receivedSignal = null;
  let forceKillTimer = null;

  const forwardSignal = (signal) => {
    receivedSignal ??= signal;
    terminateManagedChild(child, signal);
    forceKillTimer ??= setTimeout(() => {
      terminateManagedChild(child, "SIGKILL");
    }, FORCE_KILL_DELAY_MS);
  };

  for (const signal of FORWARDED_SIGNALS) {
    process.once(signal, forwardSignal);
  }
  onReady?.(child);

  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => {
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        resolve(receivedSignal ? signalExitCode(receivedSignal) : (status ?? 1));
      });
    });
  } finally {
    for (const signal of FORWARDED_SIGNALS) {
      process.off(signal, forwardSignal);
    }
  }
}

export function shouldUseManagedCommandShell(bin, platform = process.platform) {
  if (platform !== "win32") {
    return false;
  }
  const extension = extname(bin).toLowerCase();
  if (extension === ".exe" || extension === ".com") {
    return false;
  }
  return true;
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
      return 0;
  }
}

function isMissingProcessError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
}
