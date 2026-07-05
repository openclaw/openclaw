// Agent Core module implements kill tree behavior.
import { spawn } from "node:child_process";

const DEFAULT_GRACE_MS = 3000;
const MAX_GRACE_MS = 60_000;
const FORCE_KILL_SETTLE_MS = 1000;
const PROCESS_EXIT_POLL_MS = 25;
const TASKKILL_EXIT_TIMEOUT_MS = 5000;

export type KillProcessTreeOptions = {
  graceMs?: number;
  detached?: boolean;
  force?: boolean;
};

/**
 * Best-effort process-tree termination with graceful shutdown.
 * - Windows: use taskkill /T to include descendants. Sends SIGTERM-equivalent
 *   first (without /F), then force-kills if process survives.
 * - Unix: send SIGTERM to process group first, wait grace period, then SIGKILL.
 *
 * When the child was spawned with `detached: false`, pass `detached: false` to
 * skip the Unix `process.kill(-pid, ...)` group-kill. That avoids signaling the
 * gateway's own process group.
 */
export function killProcessTree(pid: number, opts?: KillProcessTreeOptions): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    if (opts?.force === true) {
      signalProcessTreeWindows(pid, "SIGKILL");
      return;
    }
    const graceMs = normalizeGraceMs(opts?.graceMs);
    killProcessTreeWindows(pid, graceMs);
    return;
  }

  const useGroupKill = opts?.detached !== false;
  if (opts?.force === true) {
    signalProcessTreeUnix(pid, "SIGKILL", useGroupKill);
    return;
  }

  const graceMs = normalizeGraceMs(opts?.graceMs);
  signalProcessTreeUnix(pid, "SIGTERM", useGroupKill);
  setTimeout(() => {
    const stillAlive = useGroupKill
      ? isProcessAlive(-pid) || isProcessAlive(pid)
      : isProcessAlive(pid);
    if (!stillAlive) {
      return;
    }
    signalProcessTreeUnix(pid, "SIGKILL", useGroupKill);
  }, graceMs).unref();
}

/**
 * Process-tree termination for callers that must not report completion while
 * cleanup is still inside the grace window.
 */
export async function killProcessTreeAndWait(
  pid: number,
  opts?: KillProcessTreeOptions,
): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    if (opts?.force === true) {
      await signalProcessTreeWindowsAndWait(pid, "SIGKILL");
      await waitForProcessTreeExit(pid, false, FORCE_KILL_SETTLE_MS);
      return;
    }
    const graceMs = normalizeGraceMs(opts?.graceMs);
    const gracefulTaskkillSucceeded = await signalProcessTreeWindowsAndWait(pid, "SIGTERM");
    if (gracefulTaskkillSucceeded && (await waitForProcessTreeExit(pid, false, graceMs))) {
      return;
    }
    await signalProcessTreeWindowsAndWait(pid, "SIGKILL");
    await waitForProcessTreeExit(pid, false, FORCE_KILL_SETTLE_MS);
    return;
  }

  const useGroupKill = opts?.detached !== false;
  if (opts?.force === true) {
    signalProcessTreeUnix(pid, "SIGKILL", useGroupKill);
    await waitForProcessTreeExit(pid, useGroupKill, FORCE_KILL_SETTLE_MS);
    return;
  }

  const graceMs = normalizeGraceMs(opts?.graceMs);
  signalProcessTreeUnix(pid, "SIGTERM", useGroupKill);
  if (await waitForProcessTreeExit(pid, useGroupKill, graceMs)) {
    return;
  }
  signalProcessTreeUnix(pid, "SIGKILL", useGroupKill);
  await waitForProcessTreeExit(pid, useGroupKill, FORCE_KILL_SETTLE_MS);
}

export function signalProcessTree(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  opts?: { detached?: boolean },
): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    signalProcessTreeWindows(pid, signal);
    return;
  }

  signalProcessTreeUnix(pid, signal, opts?.detached !== false);
}

function normalizeGraceMs(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_GRACE_MS;
  }
  return Math.max(0, Math.min(MAX_GRACE_MS, Math.floor(value)));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isProcessTreeAlive(pid: number, useGroupKill: boolean): boolean {
  if (!useGroupKill) {
    return isProcessAlive(pid);
  }
  return isProcessAlive(-pid) || isProcessAlive(pid);
}

async function waitForProcessTreeExit(
  pid: number,
  useGroupKill: boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (!isProcessTreeAlive(pid, useGroupKill)) {
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(Math.min(PROCESS_EXIT_POLL_MS, deadline - Date.now()));
    if (!isProcessTreeAlive(pid, useGroupKill)) {
      return true;
    }
  }
  return !isProcessTreeAlive(pid, useGroupKill);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function signalProcessTreeUnix(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  useGroupKill: boolean,
): void {
  if (useGroupKill) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Process group does not exist or we lack permission; try direct pid.
    }
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

function runTaskkill(args: string[]): void {
  try {
    spawn("taskkill", args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
  } catch {
    // Ignore taskkill spawn failures.
  }
}

function runTaskkillAndWait(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    const settle = (success: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve(success);
    };
    try {
      child = spawn("taskkill", args, {
        stdio: "ignore",
        windowsHide: true,
      });
      timeoutId = setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {
          // Best effort: timeout already tells the caller to escalate.
        }
        settle(false);
      }, TASKKILL_EXIT_TIMEOUT_MS);
      child.once("error", () => settle(false));
      child.once("close", (code) => settle(code === 0));
    } catch {
      settle(false);
    }
  });
}

function killProcessTreeWindows(pid: number, graceMs: number): void {
  signalProcessTreeWindows(pid, "SIGTERM");

  setTimeout(() => {
    if (!isProcessAlive(pid)) {
      return;
    }
    signalProcessTreeWindows(pid, "SIGKILL");
  }, graceMs).unref();
}

function signalProcessTreeWindows(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  const args =
    signal === "SIGKILL" ? ["/F", "/T", "/PID", String(pid)] : ["/T", "/PID", String(pid)];
  runTaskkill(args);
}

async function signalProcessTreeWindowsAndWait(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
): Promise<boolean> {
  const args =
    signal === "SIGKILL" ? ["/F", "/T", "/PID", String(pid)] : ["/T", "/PID", String(pid)];
  return runTaskkillAndWait(args);
}
