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
 *   grace period, then SIGKILL. Linux attached children are enumerated and
 *   signaled descendants-first because their process group belongs to the gateway.
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
export function killProcessTree(
  pid: number,
  opts?: KillProcessTreeOptions,
): { force: () => void } | undefined {
  if (!Number.isFinite(pid) || pid <= 0) {
    return undefined;
  }

  if (process.platform === "win32") {
    if (opts?.force === true) {
      signalProcessTreeWindows(pid, "SIGKILL");
      return undefined;
    }
    const graceMs = normalizeGraceMs(opts?.graceMs);
    killProcessTreeWindows(pid, graceMs);
    return undefined;
  }

  const useGroupKill =
    opts?.detached === true || (opts?.detached !== false && isProcessGroupLeader(pid));
  const attachedLinuxTree =
    opts?.detached === false && !useGroupKill && process.platform === "linux";
  const processTree = attachedLinuxTree ? collectUnixProcessTree(pid) : undefined;
  if (attachedLinuxTree && !processTree) {
    // A missing /proc identity cannot safely survive PID reuse. Keep the
    // immediate root TERM, but do not schedule or honor a delayed force.
    if (opts?.force !== true) {
      signalProcessTreeUnix(pid, "SIGTERM", false);
    }
    return undefined;
  }

  let forceRequested = false;
  const force = () => {
    if (forceRequested) {
      return;
    }
    forceRequested = true;
    const liveProcessTree = processTree?.filter(verifiedProcessInstanceAlive) ?? [];
    const stillAlive = useGroupKill
      ? isProcessAlive(-pid) || isProcessAlive(pid)
      : attachedLinuxTree
        ? liveProcessTree.length > 0
        : isProcessAlive(pid);
    if (!stillAlive) {
      return;
    }
    signalProcessTreeUnix(pid, "SIGKILL", useGroupKill, processTree ? liveProcessTree : undefined);
  };

  if (opts?.force === true) {
    if (processTree) {
      force();
    } else {
      signalProcessTreeUnix(pid, "SIGKILL", useGroupKill);
    }
    return undefined;
  }

  signalProcessTreeUnix(pid, "SIGTERM", useGroupKill, processTree);
  const graceMs = normalizeGraceMs(opts?.graceMs);
  const forceTimer = setTimeout(force, graceMs);
  forceTimer.unref();
  return {
    force: () => {
      clearTimeout(forceTimer);
      force();
    },
  };
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
  const attachedLinuxTree =
    opts?.detached === false && !useGroupKill && process.platform === "linux";
  const processTree = attachedLinuxTree ? collectUnixProcessTree(pid) : undefined;
  if (attachedLinuxTree && !processTree) {
    signalProcessTreeUnix(pid, signal, false);
    opts?.onComplete?.();
    return;
  }
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
 * Read a stable process-instance identity for `pid`. Linux `starttime` from
 * `/proc/<pid>/stat` distinguishes recycled PIDs. Other Unix platforms do not
 * expose a sufficiently precise portable identity, so attached snapshots stay
 * disabled there rather than authorizing a stale signal.
 */
function readUnixProcessIdentity(pid: number, deadlineMs?: number): string | undefined {
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
    return undefined;
  }
  if (process.platform !== "linux") {
    // BSD `ps lstart` is only second-granularity, so it cannot bind a delayed
    // signal to one process instance when a PID is recycled within that second.
    return undefined;
  }
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
    return starttime && /^\d+$/u.test(starttime) ? `${pid}:${starttime}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when the captured process instance is still alive at the same identity.
 * Missing identities are never eligible for an attached-tree signal.
 */
function verifiedProcessInstanceAlive(entry: UnixProcessEntry): boolean {
  if (!entry.identity || !isProcessAlive(entry.pid)) {
    return false;
  }
  return readUnixProcessIdentity(entry.pid) === entry.identity;
}

function readUnixProcessChildren(pid: number): number[] | undefined {
  try {
    return parsePositivePids(readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8"));
  } catch {
    // If a process disappears during the snapshot, abandon descendant cleanup
    // rather than risking a signal to a reused PID.
    return undefined;
  }
}

/**
 * Capture an attached process tree before signaling its root.
 * Descendants are returned first so they retain their parent relationship.
 *
 * Each entry carries a stable process-instance identity captured at discovery
 * time so delayed grace-period signals can be verified against the original
 * instance instead of a numeric PID that may have been recycled. A descendant
 * whose identity cannot be captured is omitted (fail-closed for that subtree)
 * rather than retained as an identity-less PID that a delayed signal could
 * target after reuse. The supervisor-owned root PID is always trusted as the
 * caller's direct child, so the snapshot always contains it once the root's own
 * identity verifies, even when every descendant probe fails.
 */
function collectUnixProcessTree(rootPid: number): UnixProcessTree | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  const descendants: UnixProcessEntry[] = [];
  const seen = new Set<number>([rootPid]);
  const deadline = Date.now() + UNIX_PROCESS_TREE_TIMEOUT_MS;
  const rootIdentity = readUnixProcessIdentity(rootPid, deadline);
  if (!rootIdentity || Date.now() >= deadline) {
    // The root identity is the only thing that lets a delayed signal bind to
    // the supervisor's own child process; without it the caller must fall back
    // to a single SIGTERM and skip the grace-period escalation entirely.
    return undefined;
  }

  const visit = (parentPid: number, depth: number): void => {
    if (
      Date.now() >= deadline ||
      depth > MAX_UNIX_PROCESS_TREE_DEPTH ||
      seen.size > MAX_UNIX_PROCESS_TREE_PIDS
    ) {
      return;
    }
    const children = readUnixProcessChildren(parentPid);
    if (!children) {
      // Children vanished mid-snapshot: stop descending this branch, but the
      // already-captured ancestors and the root still carry trusted identities.
      return;
    }
    for (const childPid of children) {
      if (seen.has(childPid) || childPid === process.pid) {
        continue;
      }
      seen.add(childPid);
      visit(childPid, depth + 1);
      // Bind each descendant to a captured identity so a recycled PID can never
      // match a delayed signal. If the identity cannot be read, drop this entry
      // (and the subtree it headed) instead of keeping an identity-less PID.
      const identity = readUnixProcessIdentity(childPid, deadline);
      if (identity && Date.now() < deadline) {
        descendants.push({ pid: childPid, identity });
      }
    }
  };

  visit(rootPid, 0);
  return [...descendants, { pid: rootPid, identity: rootIdentity }];
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
  for (const entry of targets) {
    if (processTree && !verifiedProcessInstanceAlive(entry)) {
      continue;
    }
    try {
      process.kill(entry.pid, signal);
    } catch {
      // A process may exit between identity verification and signaling.
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
