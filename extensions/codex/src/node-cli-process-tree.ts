import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import process from "node:process";

const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";

type ResumeChildProcess = Pick<ChildProcess, "kill" | "pid">;

type CodexResumeProcessTreeRuntime = {
  platform: NodeJS.Platform;
  spawn: typeof spawn;
  taskkillPath: string;
};

function readEnvCaseInsensitive(
  env: Record<string, string | undefined>,
  expectedKey: string,
): string | undefined {
  const direct = env[expectedKey];
  if (direct !== undefined) {
    return direct;
  }
  const expected = expectedKey.toUpperCase();
  const actualKey = Object.keys(env).find((key) => key.toUpperCase() === expected);
  return actualKey ? env[actualKey] : undefined;
}

function normalizeWindowsSystemRoot(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (
    !trimmed ||
    trimmed.includes("\0") ||
    trimmed.includes("\r") ||
    trimmed.includes("\n") ||
    trimmed.includes(";")
  ) {
    return null;
  }
  const normalized = path.win32.normalize(trimmed);
  if (!path.win32.isAbsolute(normalized) || normalized.startsWith("\\\\")) {
    return null;
  }
  const parsed = path.win32.parse(normalized);
  if (!/^[A-Za-z]:\\$/u.test(parsed.root) || normalized.length <= parsed.root.length) {
    return null;
  }
  return normalized.replace(/[\\/]+$/u, "");
}

export function resolveCodexWindowsTaskkillPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const systemRoot =
    normalizeWindowsSystemRoot(readEnvCaseInsensitive(env, "SystemRoot")) ??
    normalizeWindowsSystemRoot(readEnvCaseInsensitive(env, "WINDIR")) ??
    DEFAULT_WINDOWS_SYSTEM_ROOT;
  return path.win32.join(systemRoot, "System32", "taskkill.exe");
}

const defaultRuntime: CodexResumeProcessTreeRuntime = {
  platform: process.platform,
  spawn,
  taskkillPath: resolveCodexWindowsTaskkillPath(),
};

export function signalCodexResumeProcessTree(
  child: ResumeChildProcess,
  signal: NodeJS.Signals,
  runtime: CodexResumeProcessTreeRuntime = defaultRuntime,
): void {
  const pid = child.pid;
  if (runtime.platform !== "win32" || typeof pid !== "number") {
    child.kill(signal);
    return;
  }

  // Windows has no graceful console-tree signal; killing only the parent first
  // would orphan descendants before taskkill can enumerate them.
  const args = ["/F", "/T", "/PID", String(pid)];
  let settled = false;
  let watchdog: NodeJS.Timeout | undefined;
  const fallbackToChild = () => {
    if (settled) {
      return;
    }
    settled = true;
    if (watchdog) {
      clearTimeout(watchdog);
    }
    child.kill(signal);
  };
  const finishSuccessfully = () => {
    if (settled) {
      return;
    }
    settled = true;
    if (watchdog) {
      clearTimeout(watchdog);
    }
  };

  try {
    const taskkill = runtime.spawn(runtime.taskkillPath, args, {
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.once("error", fallbackToChild);
    taskkill.once("close", (code) => {
      if (code === 0) {
        finishSuccessfully();
      } else {
        fallbackToChild();
      }
    });
    watchdog = setTimeout(() => {
      try {
        taskkill.kill("SIGKILL");
      } catch {
        // The guarded direct-child fallback remains authoritative below.
      }
      taskkill.unref();
      fallbackToChild();
    }, WINDOWS_TASKKILL_TIMEOUT_MS);
    watchdog.unref?.();
  } catch {
    fallbackToChild();
  }
}
