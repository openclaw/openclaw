import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { resolveWindowsSystem32Executable } from "openclaw/plugin-sdk/windows-spawn";

const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;

type ResumeChildProcess = Pick<ChildProcess, "kill" | "pid">;

type CodexResumeProcessTreeRuntime = {
  platform: NodeJS.Platform;
  spawn: typeof spawn;
  taskkillPath: string;
};

const defaultRuntime: CodexResumeProcessTreeRuntime = {
  platform: process.platform,
  spawn,
  taskkillPath: resolveWindowsSystem32Executable("taskkill.exe"),
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
