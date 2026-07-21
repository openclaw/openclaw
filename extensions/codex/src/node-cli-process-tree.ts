import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import process from "node:process";

const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const WINDOWS_TASKKILL_MAX_ATTEMPTS = 2;
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
  const fallbackToChild = () => {
    if (settled) {
      return;
    }
    settled = true;
    child.kill(signal);
  };
  const finishSuccessfully = () => {
    if (settled) {
      return;
    }
    settled = true;
  };
  const runTreeKillAttempt = (attempt: number) => {
    if (settled) {
      return;
    }
    let attemptSettled = false;
    let watchdog: NodeJS.Timeout | undefined;
    const failAttempt = () => {
      if (attemptSettled || settled) {
        return;
      }
      attemptSettled = true;
      if (watchdog) {
        clearTimeout(watchdog);
      }
      if (attempt < WINDOWS_TASKKILL_MAX_ATTEMPTS) {
        runTreeKillAttempt(attempt + 1);
      } else {
        fallbackToChild();
      }
    };
    try {
      const taskkill = runtime.spawn(runtime.taskkillPath, args, {
        stdio: "ignore",
        windowsHide: true,
      });
      taskkill.once("error", failAttempt);
      taskkill.once("close", (code) => {
        if (attemptSettled || settled) {
          return;
        }
        attemptSettled = true;
        if (watchdog) {
          clearTimeout(watchdog);
        }
        if (code === 0) {
          finishSuccessfully();
        } else if (attempt < WINDOWS_TASKKILL_MAX_ATTEMPTS) {
          runTreeKillAttempt(attempt + 1);
        } else {
          fallbackToChild();
        }
      });
      watchdog = setTimeout(() => {
        if (attemptSettled || settled) {
          return;
        }
        attemptSettled = true;
        try {
          taskkill.kill("SIGKILL");
        } catch {
          // Continue with a fresh tree-level attempt below.
        }
        taskkill.unref();
        if (attempt < WINDOWS_TASKKILL_MAX_ATTEMPTS) {
          runTreeKillAttempt(attempt + 1);
        } else {
          fallbackToChild();
        }
      }, WINDOWS_TASKKILL_TIMEOUT_MS);
      watchdog.unref?.();
    } catch {
      failAttempt();
    }
  };

  runTreeKillAttempt(1);
}
