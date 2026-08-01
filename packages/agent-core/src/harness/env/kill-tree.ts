// Agent Core module implements kill tree behavior.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DEFAULT_GRACE_MS = 3000;
const MAX_GRACE_MS = 60_000;
const TASKKILL_COMPLETION_TIMEOUT_MS = 3000;
const UNIX_PROCESS_TREE_TIMEOUT_MS = 500;
// Keep synchronous cancellation bounded on hosts with unusually large trees.
const MAX_UNIX_PROCESS_TREE_PIDS = 4096;
const MAX_UNIX_PROCESS_TREE_DEPTH = 128;

type UnixProcessEntry = {
  pid: number;
  /**
   * Stable process-instance identity captured at discovery time
   * (`${pid}:${starttime}`). A recycled PID produces a different identity, so
   * delayed signals can be bound to the original process instance instead of
   * the numeric PID alone.
   */
  identity?: string;
};

type UnixProcessTree = readonly UnixProcessEntry[];

export type KillProcessTreeOptions = {
  graceMs?: number;
  detached?: boolean;
  force?: boolean;
};

/**
 * Best-effort process-tree termination with graceful shutdown.
 * - Windows: use taskkill /T to include descendants. Sends SIGTERM-equivalent
 *   first (without /F), then force-kills if taskkill refuses or the process
 *   survives the grace period.
 * - Unix: send SIGTERM to the process group when ownership is known, wait the
 *   grace period, then SIGKILL. Attached children are enumerated and signaled
 *   descendants-first because their process group belongs to the gateway.
 *
 * Group kill (`process.kill(-pid, ...)`) is only used when the PID is verified
 * as its own process group leader, unless `detached: true` is explicitly passed.
 * This prevents accidentally signaling the gateway's process group when the
 * child shares its parent's group.
 *
 * - `detached: false`: skip group kill unconditionally.
 * - `detached: true`: use group kill unconditionally (trust caller).
 * - `detached` omitted: use group kill only when PID is the group leader.
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

  const useGroupKill =
    opts?.detached === true || (opts?.detached !== false && isProcessGroupLeader(pid));
  const processTree =
    opts?.detached === false && !useGroupKill ? collectUnixProcessTree(pid) : undefined;
  if (opts?.force === true) {
    signalProcessTreeUnix(pid, "SIGKILL", useGroupKill, processTree);
    return;
  }

  const graceMs = normalizeGraceMs(opts?.graceMs);
  signalProcessTreeUnix(pid, "SIGTERM", useGroupKill, processTree);
  setTimeout(() => {
    const stillAlive = useGroupKill
      ? isProcessAlive(-pid) || isProcessAlive(pid)
      : (processTree ?? [{ pid }]).some((entry) => processInstanceAlive(entry));
    if (!stillAlive) {
      return;
    }
    const liveProcessTree = processTree?.filter(processInstanceAlive);
    signalProcessTreeUnix(pid, "SIGKILL", useGroupKill, liveProcessTree);
  }, graceMs).unref();
}

export function signalProcessTree(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  opts?: { detached?: boolean; onComplete?: () => void },
): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    opts?.onComplete?.();
    return;
  }

  if (process.platform === "win32") {
    void signalProcessTreeWindowsAndWait(pid, signal).then(opts?.onComplete);
    return;
  }

  const useGroupKill =
    opts?.detached === true || (opts?.detached !== false && isProcessGroupLeader(pid));
  const processTree =
    opts?.detached === false && !useGroupKill ? collectUnixProcessTree(pid) : undefined;
  signalProcessTreeUnix(pid, signal, useGroupKill, processTree);
  opts?.onComplete?.();
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

function parseProcessGroupId(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    return undefined;
  }
  const pgid = Number(value.trim());
  return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : undefined;
}

function readProcessGroupIdFromPs(pid: number): number | undefined {
  try {
    const res = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], {
      encoding: "utf8",
      timeout: 500,
    });
    if (res.error || res.status !== 0) {
      return undefined;
    }
    return parseProcessGroupId(res.stdout);
  } catch {
    return undefined;
  }
}

function readProcessGroupIdFromProc(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEnd = stat.lastIndexOf(")");
    if (commEnd < 0) {
      return undefined;
    }
    // After comm: state, ppid, pgrp. The command name may contain spaces or ')'.
    const fields = stat
      .slice(commEnd + 1)
      .trim()
      .split(/\s+/);
    return parseProcessGroupId(fields[2]);
  } catch {
    return undefined;
  }
}

/** Fail closed to direct-PID signaling when group ownership cannot be proved. */
function isProcessGroupLeader(pid: number): boolean {
  // Linux exposes the fact in procfs; avoid a synchronous child process on the common path.
  const procPgid = process.platform === "linux" ? readProcessGroupIdFromProc(pid) : undefined;
  const pgid = procPgid ?? readProcessGroupIdFromPs(pid);
  return pgid === pid;
}

function parsePositivePids(value: unknown): number[] {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .trim()
    .split(/\s+/u)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isSafeInteger(entry) && entry > 0);
}

/**
 * Read a stable process-instance identity for `pid`. On Linux this is the
 * `starttime` field from `/proc/<pid>/stat`; on other Unix platforms it is the
 * full `lstart=` line from `ps`. Both change when a PID is recycled, so a stale
 * cached identity no longer matches a reused PID.
 */
function readUnixProcessIdentity(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commEnd = stat.lastIndexOf(")");
      if (commEnd < 0) {
        return undefined;
      }
      const fields = stat
        .slice(commEnd + 1)
        .trim()
        .split(/\s+/);
      // Fields after comm: state ppid pgrp sid tty_nr tpgid flags ... starttime
      // starttime is field 20 in proc(5), which is index 19 in this sliced list.
      const starttime = fields[19];
      if (starttime && /^\d+$/u.test(starttime)) {
        return `${pid}:${starttime}`;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: UNIX_PROCESS_TREE_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) {
      return undefined;
    }
    const startedAt = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return startedAt ? `${pid}:${startedAt}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when the captured process instance is still alive at the same identity.
 * A bare-liveness check alone is unsafe after PID reuse; this re-reads the
 * identity and compares it to the snapshot. Pairs without an identity fall back
 * to a bare-liveness probe so the public detached/group-leader paths are
 * unchanged.
 */
function processInstanceAlive(entry: UnixProcessEntry): boolean {
  if (!isProcessAlive(entry.pid)) {
    return false;
  }
  if (!entry.identity) {
    return true;
  }
  return readUnixProcessIdentity(entry.pid) === entry.identity;
}

function readUnixProcessChildren(pid: number, deadlineMs: number): number[] | undefined {
  if (process.platform === "linux") {
    try {
      return parsePositivePids(readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8"));
    } catch {
      // If a process disappears during the snapshot, abandon descendant cleanup
      // rather than risking a signal to a reused PID.
      return undefined;
    }
  }

  try {
    const result = spawnSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 128 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: Math.max(1, deadlineMs - Date.now()),
    });
    if (result.error) {
      return undefined;
    }
    if (result.status === 1) {
      // pgrep exits 1 for both "no children" and a missing root. Verify the
      // root so a reused PID cannot be mistaken for an empty attached tree.
      return isProcessAlive(pid) ? [] : undefined;
    }
    if (result.status !== 0) {
      return undefined;
    }
    return parsePositivePids(result.stdout);
  } catch {
    return undefined;
  }
}

/**
 * Capture an attached process tree before signaling its root.
 * Descendants are returned first so they retain their parent relationship; if
 * enumeration is incomplete, callers fall back to the direct PID only.
 *
 * Each entry carries a stable process-instance identity captured at discovery
 * time so delayed grace-period signals can be verified against the original
 * instance instead of a numeric PID that may have been recycled.
 */
function collectUnixProcessTree(rootPid: number): UnixProcessTree | undefined {
  const descendants: UnixProcessEntry[] = [];
  const seen = new Set<number>([rootPid]);
  const deadline = Date.now() + UNIX_PROCESS_TREE_TIMEOUT_MS;

  const visit = (parentPid: number, depth: number): boolean => {
    if (
      Date.now() >= deadline ||
      depth > MAX_UNIX_PROCESS_TREE_DEPTH ||
      seen.size > MAX_UNIX_PROCESS_TREE_PIDS
    ) {
      return false;
    }
    const children = readUnixProcessChildren(parentPid, deadline);
    if (!children) {
      return false;
    }
    for (const childPid of children) {
      if (seen.has(childPid) || childPid === process.pid) {
        continue;
      }
      seen.add(childPid);
      if (!visit(childPid, depth + 1)) {
        return false;
      }
      // Capture identity opportunistically; if it cannot be read the entry is
      // still signalled during the initial SIGTERM pass, but a missing identity
      // forces fail-closed direct-root fallback during delayed SIGKILL.
      descendants.push({ pid: childPid, identity: readUnixProcessIdentity(childPid) });
    }
    return true;
  };

  return visit(rootPid, 0)
    ? [...descendants, { pid: rootPid, identity: readUnixProcessIdentity(rootPid) }]
    : undefined;
}

function signalProcessTreeUnix(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  useGroupKill: boolean,
  processTree?: UnixProcessTree,
): void {
  if (useGroupKill) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Process group does not exist or we lack permission; try direct pid.
    }
  }

  const targets = processTree ?? [{ pid }];
  if (signal === "SIGKILL") {
    // For the delayed force escalation, every target must still match the
    // captured process instance; an identity mismatch means the original exited
    // and the PID was reused, so it must not be signalled.
    for (const entry of targets) {
      if (processInstanceAlive(entry)) {
        try {
          process.kill(entry.pid, signal);
        } catch {
          // A process may exit between the identity check and the signal.
        }
      }
    }
    return;
  }

  for (const entry of targets) {
    try {
      process.kill(entry.pid, signal);
    } catch {
      // A process may exit between enumeration and signaling.
    }
  }
}

function runTaskkill(args: string[], onExit?: (code: number | null) => void): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(completionTimer);
      onExit?.(code);
      resolve();
    };
    const completionTimer = setTimeout(() => finish(null), TASKKILL_COMPLETION_TIMEOUT_MS);
    completionTimer.unref?.();
    try {
      const child = spawn("taskkill", args, {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      // A failed spawn emits error before a close with a negative errno. Only
      // taskkill's first actual outcome may authorize immediate escalation.
      child.once("error", () => finish(null));
      child.once("close", (code) => finish(code));
    } catch {
      // Ignore taskkill spawn failures.
      finish(null);
    }
  });
}

function killProcessTreeWindows(pid: number, graceMs: number): void {
  let forced = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const forceKill = () => {
    if (forced) {
      return;
    }
    // Latch before probing: a later live PID could belong to a reused,
    // unrelated Windows process tree.
    forced = true;
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
    if (!isProcessAlive(pid)) {
      return;
    }
    signalProcessTreeWindows(pid, "SIGKILL");
  };

  signalProcessTreeWindows(pid, "SIGTERM", (code) => {
    if (code !== null && code !== 0) {
      forceKill();
    }
  });

  graceTimer = setTimeout(forceKill, graceMs);
  graceTimer.unref();
}

function signalProcessTreeWindows(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  onExit?: (code: number | null) => void,
): void {
  void signalProcessTreeWindowsAndWait(pid, signal, onExit);
}

function signalProcessTreeWindowsAndWait(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  onExit?: (code: number | null) => void,
): Promise<void> {
  const args =
    signal === "SIGKILL" ? ["/F", "/T", "/PID", String(pid)] : ["/T", "/PID", String(pid)];
  return runTaskkill(args, onExit);
}
