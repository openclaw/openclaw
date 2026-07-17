/**
 * Shared transport lifecycle helpers for stdio and WebSocket Codex app-server
 * connections.
 */
import { spawn } from "node:child_process";

/** Child-process-like transport shape consumed by the Codex app-server client. */
export type CodexAppServerTransport = {
  stdin: {
    write: (data: string, callback?: (error?: Error | null) => void) => unknown;
    end?: () => unknown;
    destroy?: () => unknown;
    unref?: () => unknown;
    on?: (event: "error", listener: (error: Error) => void) => unknown;
  };
  stdout: NodeJS.ReadableStream & {
    destroy?: () => unknown;
    unref?: () => unknown;
  };
  stderr: NodeJS.ReadableStream & {
    destroy?: () => unknown;
    unref?: () => unknown;
  };
  pid?: number;
  exitCode?: number | null;
  signalCode?: string | null;
  killed?: boolean;
  /** True when OpenClaw spawned this PID as an owned POSIX process-group leader. */
  processGroupOwned?: boolean;
  kill?: (signal?: NodeJS.Signals) => unknown;
  unref?: () => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

const PROCESS_TREE_EXIT_POLL_INTERVAL_MS = 10;

export type CodexAppServerTransportCloseAndWaitOptions = {
  exitTimeoutMs?: number;
  forceKillDelayMs?: number;
  processTreeTimeoutMs?: number;
};

/** Starts graceful transport shutdown and schedules a force kill fallback. */
export function closeCodexAppServerTransport(
  child: CodexAppServerTransport,
  options: { forceKillDelayMs?: number } = {},
): void {
  child.stdin.end?.();
  child.stdin.destroy?.();
  const forceKillDelayMs = options.forceKillDelayMs ?? 1_000;
  const forceKill = setTimeout(
    () => {
      if (hasCodexAppServerTransportExited(child)) {
        return;
      }
      signalCodexAppServerTransport(child, "SIGKILL");
    },
    Math.max(1, forceKillDelayMs),
  );
  forceKill.unref?.();
  child.once("exit", () => {
    clearTimeout(forceKill);
    child.stdout.destroy?.();
    child.stderr.destroy?.();
  });
  child.unref?.();
  child.stdout.unref?.();
  child.stderr.unref?.();
  child.stdin.unref?.();
}

/** Closes a transport and waits briefly for an exit event. */
export async function closeCodexAppServerTransportAndWait(
  child: CodexAppServerTransport,
  options: CodexAppServerTransportCloseAndWaitOptions = {},
): Promise<boolean> {
  if (options.processTreeTimeoutMs !== undefined) {
    return await terminateCodexAppServerTransportProcessTreeAndWait(child, {
      timeoutMs: options.processTreeTimeoutMs,
    });
  }
  if (!hasCodexAppServerTransportExited(child)) {
    closeCodexAppServerTransport(child, options);
  }
  return await waitForCodexAppServerTransportExit(child, options.exitTimeoutMs ?? 2_000);
}

/** Force-kills an owned local app-server process group and confirms it is empty. */
async function terminateCodexAppServerTransportProcessTreeAndWait(
  child: CodexAppServerTransport,
  options: { timeoutMs: number },
): Promise<boolean> {
  const pid = normalizeTransportPid(child.pid);
  if (pid === undefined) {
    return false;
  }
  if (process.platform === "win32") {
    // exitCode/signalCode are the transport's exact root-exit latch. Once set,
    // the numeric PID is reusable and must never regain taskkill authority.
    if (hasCodexAppServerTransportExited(child)) {
      return false;
    }
    return await terminateWindowsCodexAppServerProcessTreeAndWait(pid, options.timeoutMs);
  }
  if (child.processGroupOwned !== true) {
    return false;
  }

  signalCodexAppServerTransportProcess(pid, "SIGKILL");
  signalCodexAppServerTransportProcess(-pid, "SIGKILL");
  child.kill?.("SIGKILL");
  const deadline = Date.now() + Math.max(1, Math.floor(options.timeoutMs));
  while (Date.now() < deadline) {
    if (
      !isCodexAppServerTransportProcessAlive(pid) &&
      !isCodexAppServerTransportProcessAlive(-pid)
    ) {
      return true;
    }
    await new Promise<void>((resolve) => {
      const remainingMs = Math.max(1, deadline - Date.now());
      setTimeout(resolve, Math.min(PROCESS_TREE_EXIT_POLL_INTERVAL_MS, remainingMs));
    });
  }
  return (
    !isCodexAppServerTransportProcessAlive(pid) && !isCodexAppServerTransportProcessAlive(-pid)
  );
}

function hasCodexAppServerTransportExited(child: CodexAppServerTransport): boolean {
  return child.exitCode !== null && child.exitCode !== undefined
    ? true
    : child.signalCode !== null && child.signalCode !== undefined;
}

async function waitForCodexAppServerTransportExit(
  child: CodexAppServerTransport,
  timeoutMs: number,
): Promise<boolean> {
  if (hasCodexAppServerTransportExited(child)) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const onExit = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(
      () => {
        if (settled) {
          return;
        }
        settled = true;
        child.off?.("exit", onExit);
        resolve(false);
      },
      Math.max(1, timeoutMs),
    );
    child.once("exit", onExit);
  });
}

function signalCodexAppServerTransport(
  child: CodexAppServerTransport,
  signal: NodeJS.Signals,
): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the child handle. The process may already be gone or not
      // be a process-group leader on older call sites.
    }
  }
  child.kill?.(signal);
}

function normalizeTransportPid(pid: number | undefined): number | undefined {
  return typeof pid === "number" && Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

function signalCodexAppServerTransportProcess(pid: number, signal: "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone or no longer signalable; the following probe decides.
  }
}

function isCodexAppServerTransportProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateWindowsCodexAppServerProcessTreeAndWait(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  if (!isCodexAppServerTransportProcessAlive(pid)) {
    return false;
  }
  const taskkillSucceeded = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const taskkill = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    const timeout = setTimeout(
      () => {
        taskkill.kill();
        finish(false);
      },
      Math.max(1, Math.floor(timeoutMs)),
    );
    timeout.unref?.();
    taskkill.once("error", () => finish(false));
    taskkill.once("close", (code) => finish(code === 0));
  });
  return taskkillSucceeded && !isCodexAppServerTransportProcessAlive(pid);
}
