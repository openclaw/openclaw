import { spawn, spawnSync } from "node:child_process";
import { opendirSync, readFileSync } from "node:fs";

const DEFAULT_GRACE_MS = 3000;
const MAX_GRACE_MS = 60_000;
const TASKKILL_COMPLETION_TIMEOUT_MS = 3000;
const UNIX_PROCESS_TREE_TIMEOUT_MS = 500;
// Keep synchronous cancellation bounded on hosts with unusually large trees.
const MAX_UNIX_PROCESS_TREE_PIDS = 4096;
const MAX_UNIX_PROCESS_TREE_DEPTH = 128;

type UnixProcessEntry = {
  pid: number;
  /** `${pid}:${starttime}` binds delayed signals to the captured process, not a recycled PID. */
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
      void signalProcessTreeWindowsAndWait(pid, "SIGKILL");
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
    // Preserve immediate termination of the caller-owned root. Missing procfs
    // identity cannot authorize descendants or any delayed escalation.
    signalProcessTreeUnix(pid, opts?.force === true ? "SIGKILL" : "SIGTERM", false);
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
      ? isProcessAlive(-pid)
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
  // The root can settle before an attached descendant exits. Keep its retained
  // escalation alive even when that root owned the last event-loop handle.
  if (!attachedLinuxTree) {
    forceTimer.unref();
  }
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
  signalProcessTreeUnix(pid, signal, useGroupKill, processTree);
  opts?.onComplete?.();
}

/** Capture the group selected by signalProcessTree while its leader still exists. */
export function readUnixProcessGroupMembers(pid: number): number[] {
  if (process.platform === "win32" || !isProcessGroupLeader(pid)) {
    return [pid];
  }
  const output = readPsOutput(["-axo", "pid=,pgid="]);
  const members = new Set([pid]);
  for (const line of output?.split("\n") ?? []) {
    const [memberText, groupText] = line.trim().split(/\s+/);
    const member = parseProcessGroupId(memberText);
    if (member && parseProcessGroupId(groupText) === pid) {
      members.add(member);
    }
  }
  return [...members];
}

/** Signals every process group and process still owned by one forkpty session. */
export function signalPtySessionTree(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    void signalProcessTreeWindowsAndWait(pid, signal);
    return;
  }
  const darwinTty = process.platform === "darwin" ? readDarwinPtyTty(pid) : undefined;
  if (process.platform === "darwin" && !darwinTty) {
    signalUnixTarget(-pid, signal);
    return;
  }
  const members = readProcessSessionMembers(pid, darwinTty);
  if (!members) {
    signalUnixTarget(-pid, signal);
    return;
  }
  const signalMembers = (snapshot: Array<{ pid: number; pgid: number }>) => {
    const groups = new Set(snapshot.map((member) => member.pgid));
    groups.delete(pid);
    for (const pgid of groups) {
      signalUnixTarget(-pgid, signal);
    }
    for (const member of snapshot) {
      if (member.pid !== pid) {
        signalUnixTarget(member.pid, signal);
      }
    }
  };
  signalMembers(members);
  // Keep the leader alive through the rescan: Darwin drops the controlling-tty
  // lookup once the session leader exits.
  const remaining = readProcessSessionMembers(pid, darwinTty);
  if (remaining) {
    signalMembers(remaining);
  }
  signalUnixTarget(-pid, signal);
  signalUnixTarget(pid, signal);
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
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EPERM") {
      return false;
    }
  }
  // Negative targets represent process groups, not procfs process entries.
  if (pid < 0 || process.platform !== "linux") {
    return true;
  }
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const stateMatch = status.match(/^State:\s+(\S)/m);
    // A zombie leader can retain live worker threads. Only a fully exited,
    // single-thread process is dead for escalation purposes.
    return !(stateMatch?.[1] === "Z" && /^Threads:[ \t]+1[ \t]*$/m.test(status));
  } catch {
    return true;
  }
}

function parseProcessGroupId(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    return undefined;
  }
  const pgid = Number(value.trim());
  return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : undefined;
}

function readPsOutput(args: string[]): string | undefined {
  try {
    const result = spawnSync("ps", args, {
      encoding: "utf8",
      timeout: 500,
    });
    return result.error || result.status !== 0 ? undefined : result.stdout;
  } catch {
    return undefined;
  }
}

function readProcStatFields(pid: number): string[] | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEnd = stat.lastIndexOf(")");
    if (commEnd < 0) {
      return undefined;
    }
    // After comm: state, ppid, pgrp. The command name may contain spaces or ')'.
    return stat
      .slice(commEnd + 1)
      .trim()
      .split(/\s+/);
  } catch {
    return undefined;
  }
}

function readDarwinPtyTty(sessionLeaderPid: number): string | undefined {
  // Darwin ps omits numeric SIDs; the trusted forkpty leader owns its controlling tty.
  const tty = readPsOutput(["-p", String(sessionLeaderPid), "-o", "tty="])?.trim();
  return tty && tty !== "?" && tty !== "??" ? tty : undefined;
}

function readProcessSessionMembers(
  sessionId: number,
  darwinTty?: string,
): Array<{ pid: number; pgid: number }> | undefined {
  const expectedSession = darwinTty ?? String(sessionId);
  const args = darwinTty ? ["-t", darwinTty, "-o", "pid=,pgid="] : ["-axo", "pid=,pgid=,sid="];
  const output = readPsOutput(args);
  if (output === undefined) {
    return undefined;
  }
  const members: Array<{ pid: number; pgid: number }> = [];
  for (const line of output.split("\n")) {
    const [pidText, pgidText, session] = line.trim().split(/\s+/);
    const pid = parseProcessGroupId(pidText);
    const pgid = parseProcessGroupId(pgidText);
    if (pid && pgid && (darwinTty || session === expectedSession)) {
      members.push({ pid, pgid });
    }
  }
  return members;
}

/** Fail closed to direct-PID signaling when group ownership cannot be proved. */
function isProcessGroupLeader(pid: number): boolean {
  // Linux exposes the fact in procfs; avoid a synchronous child process on the common path.
  const procPgid =
    process.platform === "linux" ? parseProcessGroupId(readProcStatFields(pid)?.[2]) : undefined;
  const pgid = procPgid ?? parseProcessGroupId(readPsOutput(["-p", String(pid), "-o", "pgid="]));
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

function readUnixProcessIdentity(pid: number, deadlineMs?: number): string | undefined {
  return readUnixProcessInstance(pid, deadlineMs)?.identity;
}

/** Capture identity and parent together so a recycled child PID cannot authorize a foreign tree. */
function readUnixProcessInstance(
  pid: number,
  deadlineMs?: number,
): { identity: string; ppid: number } | undefined {
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
    return undefined;
  }
  if (process.platform !== "linux") {
    // BSD `ps lstart` is only second-granularity, so it cannot bind a delayed
    // signal to one process instance when a PID is recycled within that second.
    return undefined;
  }
  const fields = readProcStatFields(pid);
  // After comm, state is index 0; ppid (field 4) is index 1 and starttime (field 22) is 19.
  const ppid = Number(fields?.[1]);
  const starttime = fields?.[19];
  if (!starttime || !/^\d+$/u.test(starttime) || !Number.isSafeInteger(ppid)) {
    return undefined;
  }
  return { identity: `${pid}:${starttime}`, ppid };
}

/** Missing identities are never eligible for an attached-tree signal. */
function verifiedProcessInstanceAlive(entry: UnixProcessEntry): boolean {
  if (!entry.identity || !isProcessAlive(entry.pid)) {
    return false;
  }
  return readUnixProcessIdentity(entry.pid) === entry.identity;
}

function* readUnixProcessChildren(pid: number, canReadTask: () => boolean): Generator<number> {
  let tasks: ReturnType<typeof opendirSync> | undefined;
  try {
    tasks = opendirSync(`/proc/${pid}/task`);
    // Linux children lists are per thread, not per process. Walk incrementally
    // so a process with many threads cannot evade the snapshot's work bound.
    while (canReadTask()) {
      const task = tasks.readSync();
      if (!task) {
        return;
      }
      const tid = parseProcessGroupId(task.name);
      if (!tid) {
        continue;
      }
      try {
        yield* parsePositivePids(readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8"));
      } catch {
        // An individual thread can exit while its process remains alive.
      }
    }
  } catch {
    // An inaccessible or exited process contributes no descendants.
  } finally {
    try {
      tasks?.closeSync();
    } catch {
      // Directory cleanup must not prevent termination of captured instances.
    }
  }
}

/** Capture verified descendants before their parents; an unverified subtree is omitted. */
function collectUnixProcessTree(rootPid: number): UnixProcessTree | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  const descendants: UnixProcessEntry[] = [];
  const seen = new Set<number>([rootPid]);
  let taskReads = 0;
  const deadline = Date.now() + UNIX_PROCESS_TREE_TIMEOUT_MS;
  const rootIdentity = readUnixProcessIdentity(rootPid, deadline);
  if (!rootIdentity || Date.now() >= deadline) {
    // The root identity is the only thing that lets a delayed signal bind to
    // the supervisor's own child process; without it the caller must fall back
    // to one immediate root signal and skip grace-period escalation entirely.
    return undefined;
  }

  const withinBounds = (depth: number): boolean =>
    Date.now() < deadline && depth <= MAX_UNIX_PROCESS_TREE_DEPTH;
  const hasCapacity = (): boolean => seen.size < MAX_UNIX_PROCESS_TREE_PIDS;

  const visit = (parentPid: number, parentIdentity: string, depth: number): void => {
    if (!withinBounds(depth) || !hasCapacity()) {
      return;
    }
    // Even the root can be recycled after capture. Revalidate before trusting
    // its children file; the child's numeric ppid alone cannot prove ownership.
    if (readUnixProcessIdentity(parentPid, deadline) !== parentIdentity) {
      return;
    }
    const children = readUnixProcessChildren(
      parentPid,
      () =>
        withinBounds(depth) &&
        hasCapacity() &&
        taskReads++ < MAX_UNIX_PROCESS_TREE_PIDS &&
        readUnixProcessIdentity(parentPid, deadline) === parentIdentity,
    );
    for (const childPid of children) {
      // Bound the child's depth, not its parent's, before admitting it.
      if (!withinBounds(depth + 1) || !hasCapacity()) {
        return;
      }
      if (seen.has(childPid) || childPid === process.pid) {
        continue;
      }
      seen.add(childPid);
      // A child recycled since the children read must still belong to this
      // verified parent. Capture its identity before descending.
      const instance = readUnixProcessInstance(childPid, deadline);
      if (!instance || instance.ppid !== parentPid || !withinBounds(depth + 1)) {
        continue;
      }
      visit(childPid, instance.identity, depth + 1);
      descendants.push({ pid: childPid, identity: instance.identity });
    }
  };

  visit(rootPid, rootIdentity, 0);
  return [...descendants, { pid: rootPid, identity: rootIdentity }];
}

function signalProcessTreeUnix(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  useGroupKill: boolean,
  processTree?: UnixProcessTree,
): void {
  if (useGroupKill) {
    // A selected group remains the only target after its leader exits. Never
    // fall back to its positive PID, which may already be an unrelated process.
    signalUnixTarget(-pid, signal);
    return;
  }

  const targets = processTree ?? [{ pid }];
  for (const entry of targets) {
    if (processTree && !verifiedProcessInstanceAlive(entry)) {
      continue;
    }
    signalUnixTarget(entry.pid, signal);
  }
}

function signalUnixTarget(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone or not signalable; remaining exact targets still run.
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
    void signalProcessTreeWindowsAndWait(pid, "SIGKILL");
  };

  void signalProcessTreeWindowsAndWait(pid, "SIGTERM", (code) => {
    if (code !== null && code !== 0) {
      forceKill();
    }
  });

  graceTimer = setTimeout(forceKill, graceMs);
  graceTimer.unref();
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
