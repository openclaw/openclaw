// Agent Core module implements kill tree behavior.
import { spawn } from "node:child_process";

const DEFAULT_GRACE_MS = 3000;
const MAX_GRACE_MS = 60_000;

export type KillProcessTreeOptions = {
  graceMs?: number;
  detached?: boolean;
  force?: boolean;
};

/**
 * Best-effort process-tree termination with graceful shutdown.
 * - Windows: use taskkill /T to include descendants. Sends SIGTERM-equivalent
 *   first (without /F), then force-kills if process survives.
 * - Unix: send SIGTERM to the process, wait grace period, then SIGKILL.
 *
 * By default, Unix kills use direct `process.kill(pid, ...)` only. Pass
 * `detached: true` to opt into `process.kill(-pid, ...)` group-kill, which
 * targets the entire process group. Group-kill is only safe when the child
 * was spawned with `detached: true` and is its own process group leader;
 * otherwise it signals the caller's own group — including the gateway.
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

  const useGroupKill = opts?.detached === true;
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

  signalProcessTreeUnix(pid, signal, opts?.detached === true);
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
