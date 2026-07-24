import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import process from "node:process";

const RESUME_FORCE_KILL_DELAY_MS = 2_000;
const WINDOWS_TASKKILL_MAX_ATTEMPTS = 2;
const WINDOWS_TASKKILL_TIMEOUT_MS = RESUME_FORCE_KILL_DELAY_MS / WINDOWS_TASKKILL_MAX_ATTEMPTS;
const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";

type ResumeChildExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

type ResumeChildProcess = Pick<ChildProcess, "exitCode" | "kill" | "pid"> & {
  once(event: "exit", listener: ResumeChildExitListener): unknown;
  off(event: "exit", listener: ResumeChildExitListener): unknown;
};

type CodexResumeProcessTreeRuntime = {
  platform: NodeJS.Platform;
  spawn: typeof spawn;
  env: Record<string, string | undefined>;
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

function resolveCodexWindowsTaskkillPath(
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
  env: process.env,
};

function terminateWindowsProcessTree(
  child: ResumeChildProcess,
  pid: number,
  runtime: CodexResumeProcessTreeRuntime,
): void {
  // Windows has no graceful console-tree signal; killing only the parent first
  // would orphan descendants before taskkill can enumerate them.
  const taskkillPath = resolveCodexWindowsTaskkillPath(runtime.env);
  const args = ["/F", "/T", "/PID", String(pid)];
  let settled = false;
  let childExited = false;
  let activeTaskkill: ChildProcess | undefined;
  let activeWatchdog: NodeJS.Timeout | undefined;
  function handleChildExit() {
    childExited = true;
    if (!activeTaskkill) {
      finishForChildExit();
    }
  }
  const clearActiveAttempt = () => {
    if (activeWatchdog) {
      clearTimeout(activeWatchdog);
      activeWatchdog = undefined;
    }
    activeTaskkill = undefined;
  };
  const removeChildExitListener = () => child.off("exit", handleChildExit);
  const finishForChildExit = () => {
    if (settled) {
      return;
    }
    settled = true;
    if (activeWatchdog) {
      clearTimeout(activeWatchdog);
      activeWatchdog = undefined;
    }
    activeTaskkill = undefined;
    removeChildExitListener();
  };
  const fallbackToChild = () => {
    if (settled) {
      return;
    }
    settled = true;
    clearActiveAttempt();
    removeChildExitListener();
    child.kill("SIGKILL");
  };
  const finishSuccessfully = () => {
    if (settled) {
      return;
    }
    settled = true;
    clearActiveAttempt();
    removeChildExitListener();
  };
  const canRetryOriginalChild = () => !settled && !childExited && child.exitCode === null;
  const runTreeKillAttempt = (attempt: number) => {
    if (!canRetryOriginalChild()) {
      finishForChildExit();
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
      if (!canRetryOriginalChild()) {
        finishForChildExit();
      } else if (attempt < WINDOWS_TASKKILL_MAX_ATTEMPTS) {
        runTreeKillAttempt(attempt + 1);
      } else {
        fallbackToChild();
      }
    };
    try {
      const taskkill = runtime.spawn(taskkillPath, args, {
        stdio: "ignore",
        windowsHide: true,
      });
      activeTaskkill = taskkill;
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
        } else if (!canRetryOriginalChild()) {
          finishForChildExit();
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
        if (!canRetryOriginalChild()) {
          finishForChildExit();
        } else if (attempt < WINDOWS_TASKKILL_MAX_ATTEMPTS) {
          runTreeKillAttempt(attempt + 1);
        } else {
          fallbackToChild();
        }
      }, WINDOWS_TASKKILL_TIMEOUT_MS);
      activeWatchdog = watchdog;
      watchdog.unref?.();
    } catch {
      failAttempt();
    }
  };

  child.once("exit", handleChildExit);
  runTreeKillAttempt(1);
}

export function terminateCodexResumeProcess(
  child: ResumeChildProcess,
  runtime: CodexResumeProcessTreeRuntime = defaultRuntime,
): NodeJS.Timeout | undefined {
  if (child.exitCode !== null) {
    return undefined;
  }
  if (runtime.platform === "win32" && typeof child.pid === "number") {
    terminateWindowsProcessTree(child, child.pid, runtime);
    return undefined;
  }

  child.kill("SIGTERM");
  const forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), RESUME_FORCE_KILL_DELAY_MS);
  forceKillTimeout.unref?.();
  return forceKillTimeout;
}
