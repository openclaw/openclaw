// Runs child commands with process-group signal forwarding and Windows shell normalization.
import { spawn, spawnSync } from "node:child_process";
import type {
  ChildProcess,
  ChildProcessByStdio,
  SpawnOptions,
  SpawnOptionsWithStdioTuple,
  StdioOptions,
} from "node:child_process";
import { constants as osConstants, tmpdir } from "node:os";
import { Writable, type Readable } from "node:stream";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "../windows-cmd-helpers.mjs";
import type { ManagedWindowsJob } from "./managed-windows-job.mts";
import { findVitestResourceOwner } from "./vitest-resource-ownership.mts";
import { resolveWindowsTaskkillPath } from "./windows-taskkill.mjs";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] satisfies NodeJS.Signals[];
const FORCE_KILL_DELAY_MS = 5_000;
const PROCESS_GROUP_DRAIN_TIMEOUT_MS = 5_000;
const PROCESS_GROUP_POLL_MS = 25;
const TASKKILL_TIMEOUT_MS = 10_000;
type ProcessTreeState = "indeterminate" | "live" | "signaled" | "terminated";
type ManagedChildTermination = {
  processTreeState: Exclude<ProcessTreeState, "live">;
  error?: Error;
  survivingPids?: number[];
};
type ManagedProcessGroupErrorPolicy = "alive-on-eperm" | "indeterminate";
type ManagedProcessGroupChild = {
  exitCode?: number | null;
  pid?: number;
  signalCode?: string | null;
};
type ManagedProcessGroupOptions = {
  deadlineAt?: number;
  onProbe?: (result: string) => void;
  errorPolicy: ManagedProcessGroupErrorPolicy;
  inspectLeaderWhenNoGroup?: boolean;
  platform?: NodeJS.Platform;
  useProcessGroup?: boolean;
};
type TaskkillRunner = (
  command: string,
  args: string[],
  options: { killSignal?: NodeJS.Signals; stdio?: StdioOptions; timeout?: number },
) =>
  | {
      error?: Error;
      status: number | null;
      signal?: NodeJS.Signals | null;
      stdout?: Buffer | string | null;
      stderr?: Buffer | string | null;
    }
  | undefined;
type ManagedChildTerminationOptions = {
  onChildSignalError?: (error: unknown) => void;
  onProcessGroupSignalError?: (error: unknown) => void;
  platform?: NodeJS.Platform;
  processGroupFallback?: "always" | "never" | "nonmissing";
  runTaskkill?: TaskkillRunner;
  taskkillTimeoutMs?: number | null;
  useProcessGroup?: boolean;
  useWindowsTaskkill?: boolean;
};

type ManagedCommandOptions = {
  bin: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  shell?: boolean;
  windowsVerbatimArguments?: boolean;
  platform?: NodeJS.Platform;
  comSpec?: string;
};

type RunManagedCommandOptions = ManagedCommandOptions & {
  timeoutMs?: number;
  timeoutKillGraceMs?: number;
  signalKillGraceMs?: number;
  timeoutForceKillOnLeaderExit?: boolean;
  requireProcessTreeExit?: boolean;
  runTaskkill?: TaskkillRunner;
  onReady?: (child: ChildProcess) => void;
  signal?: AbortSignal;
  abortKillGraceMs?: number;
  cleanupDrainTimeoutMs?: number;
  onSignal?: (signal: NodeJS.Signals) => void;
};

type ManagedCommandOutcome =
  | { type: "completed"; exit: number | NodeJS.Signals }
  | { type: "failed"; error: unknown }
  | { type: "timeout" }
  | { type: "aborted" }
  | { type: "signal"; signal: NodeJS.Signals };

const managedChildren = new Set<(signal: NodeJS.Signals) => void>();
const signalHandlers = new Map<NodeJS.Signals, () => void>();
const windowsJobs = new WeakMap<object, ManagedWindowsJob>();
const windowsTerminations = new WeakMap<object, ManagedChildTermination>();

/** Resolve platform code before spawning so callers can attach listeners synchronously. */
export function loadManagedChildSpawner(platform = process.platform) {
  if (platform !== "win32") {
    return spawn;
  }
  return import("./managed-windows-job.mts").then(({ spawnWindowsJobChild }) => {
    function spawnManagedChild(
      command: string,
      args: string[],
      options: SpawnOptionsWithStdioTuple<"ignore", "pipe", "pipe">,
    ): ChildProcessByStdio<null, Readable, Readable>;
    function spawnManagedChild(
      command: string,
      args: string[],
      options: SpawnOptions,
    ): ChildProcess;
    function spawnManagedChild(
      command: string,
      args: string[],
      options: SpawnOptions,
    ): ChildProcess {
      const owned = spawnWindowsJobChild(command, args, options);
      if (!owned) {
        return spawn(command, args, options);
      }
      windowsJobs.set(owned.child, owned.job);
      return owned.child;
    }
    return spawnManagedChild;
  });
}

function observeWindowsTree(child: ManagedProcessGroupChild): ManagedChildTermination {
  const job = windowsJobs.get(child);
  if (!job) {
    return windowsTerminations.get(child) ?? { processTreeState: "indeterminate" };
  }
  try {
    const survivingPids = job.inspect();
    return {
      processTreeState: survivingPids.length === 0 ? "terminated" : "indeterminate",
      survivingPids,
    };
  } catch (error) {
    return {
      processTreeState: "indeterminate",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/** Nested command failures retain their owner's inputs until process cleanup is verified. */
export function hasUnjoinedWork(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  for (const current of pending) {
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    // Native execFileSync errors can point .error back to themselves. Skip only
    // that identity; other aggregate members and wrapper edges still need checking.
    seen.add(current);
    if ("processTreeState" in current && current.processTreeState !== "terminated") {
      return true;
    }
    // Rolldown preserves plugin failures in a plain Error.errors array.
    if ("errors" in current && Array.isArray(current.errors)) {
      for (const error of current.errors) {
        pending.push(error);
      }
    }
    if ("cause" in current) {
      pending.push(current.cause);
    }
    if ("error" in current) {
      pending.push(current.error);
    }
  }
  return false;
}

/** Return the conventional shell exit code for a signal. */
export function signalExitCode(signal: NodeJS.Signals) {
  const signalNumber = signalNumberFor(signal);
  return signalNumber ? 128 + signalNumber : 1;
}

export function terminateManagedChild(
  child: ManagedProcessGroupChild & { kill(signal: NodeJS.Signals): unknown },
  signal: NodeJS.Signals = "SIGTERM",
  {
    onChildSignalError,
    onProcessGroupSignalError,
    platform = process.platform,
    processGroupFallback = "always",
    runTaskkill = spawnSync,
    taskkillTimeoutMs = TASKKILL_TIMEOUT_MS,
    useProcessGroup = platform !== "win32",
    useWindowsTaskkill = true,
  }: ManagedChildTerminationOptions = {},
): ManagedChildTermination | undefined {
  if (!child.pid) {
    try {
      const delivered = child.kill(signal);
      if (platform !== "win32") {
        return { processTreeState: delivered === false ? "terminated" : "signaled" };
      }
    } catch (error) {
      onChildSignalError?.(error);
      // A child that never acquired a PID may already have failed to spawn.
    }
    return platform === "win32" ? { processTreeState: "indeterminate" } : undefined;
  }

  const job = platform === "win32" ? windowsJobs.get(child) : undefined;
  job?.beginStop();

  let processGroupIsMissing = false;
  try {
    if (platform !== "win32" && useProcessGroup) {
      process.kill(-child.pid, signal);
      return { processTreeState: "signaled" };
    }
  } catch (error) {
    processGroupIsMissing = isMissingProcessError(error);
    if (!processGroupIsMissing) {
      onProcessGroupSignalError?.(error);
    }
    if (
      processGroupFallback === "never" ||
      (processGroupFallback === "nonmissing" && processGroupIsMissing)
    ) {
      return processGroupIsMissing ? { processTreeState: "terminated" } : undefined;
    }
  }

  if (platform !== "win32" || !useWindowsTaskkill) {
    const missingLeaderState =
      useProcessGroup && !processGroupIsMissing ? "indeterminate" : "terminated";
    try {
      const delivered = child.kill(signal);
      return { processTreeState: delivered === false ? missingLeaderState : "signaled" };
    } catch (error) {
      onChildSignalError?.(error);
      return isMissingProcessError(error) ? { processTreeState: missingLeaderState } : undefined;
    }
  }

  // After exit this PID can name another process. Keep descendant cleanup
  // unverified instead of targeting that potentially unrelated owner.
  if (child.exitCode != null || child.signalCode != null) {
    if (job) {
      try {
        job.stop();
      } catch (error) {
        onChildSignalError?.(error);
      }
    }
    return observeWindowsTree(child);
  }
  const taskkillPath = resolveWindowsTaskkillPath();
  const args = ["/PID", String(child.pid), "/T"];
  if (signal === "SIGKILL") {
    args.push("/F");
  }
  const taskkillOptions: Parameters<TaskkillRunner>[2] =
    taskkillTimeoutMs === null
      ? { stdio: ["ignore", "pipe", "pipe"] }
      : { killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"], timeout: taskkillTimeoutMs };
  const result = runTaskkill(taskkillPath, args, taskkillOptions);
  const attempts = [result];
  if (
    (result?.error || result?.status !== 0) &&
    signal !== "SIGKILL" &&
    !hasManagedChildExited(child)
  ) {
    attempts.push(runTaskkill(taskkillPath, [...args, "/F"], taskkillOptions));
  }
  // Taskkill enumerates a tree; the retained Job also owns children created during that walk.
  if (job && observeWindowsTree(child).processTreeState !== "terminated") {
    try {
      job.stop();
    } catch (error) {
      onChildSignalError?.(error);
    }
  }
  if (attempts.some((attempt) => !attempt?.error && attempt?.status === 0)) {
    windowsTerminations.set(child, { processTreeState: "terminated" });
    return job ? observeWindowsTree(child) : { processTreeState: "terminated" };
  }
  try {
    if (!hasManagedChildExited(child)) {
      child.kill(signal);
    }
  } catch (error) {
    onChildSignalError?.(error);
    // The leader may already be gone, but failed taskkill leaves descendants unverified.
  }
  const taskkill = attempts.map((attempt) => ({
    status: attempt?.status ?? null,
    signal: attempt?.signal ?? null,
    stdout: attempt?.stdout?.toString() ?? "",
    stderr: attempt?.stderr?.toString() ?? "",
    error: attempt?.error?.message,
  }));
  const observation: ManagedChildTermination = job
    ? observeWindowsTree(child)
    : { processTreeState: "indeterminate" };
  const termination: ManagedChildTermination = {
    ...observation,
    error: Object.assign(
      createManagedCommandCleanupError(
        `Windows taskkill failed: ${JSON.stringify(taskkill)}`,
        child,
        platform,
        "indeterminate",
        observation.error,
      ),
      { taskkill, survivingPids: observation.survivingPids },
    ),
  };
  windowsTerminations.set(child, termination);
  return termination;
}

function hasManagedChildExited(child: ManagedProcessGroupChild): boolean {
  // Leader facts only retire PID signaling authority; they never certify the tree.
  if (child.exitCode != null || child.signalCode != null) {
    return true;
  }
  if (child.pid) {
    // spawnSync blocks exit-event delivery; query the kernel before the caller drains output.
    try {
      process.kill(child.pid, 0);
    } catch (error) {
      return isMissingProcessError(error);
    }
  }
  return false;
}

export function inspectManagedProcessGroup(
  child: ManagedProcessGroupChild,
  {
    deadlineAt,
    onProbe,
    errorPolicy,
    inspectLeaderWhenNoGroup = false,
    platform = process.platform,
    useProcessGroup = platform !== "win32",
  }: ManagedProcessGroupOptions,
): "dead" | "indeterminate" | "live" {
  if (platform === "win32" && !inspectLeaderWhenNoGroup) {
    return observeWindowsTree(child).processTreeState === "terminated" ? "dead" : "indeterminate";
  }
  if (!useProcessGroup) {
    return inspectLeaderWhenNoGroup &&
      child.pid &&
      child.exitCode === null &&
      child.signalCode === null
      ? "live"
      : "dead";
  }
  const { pid } = child;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1 || pid > 0x7fffffff) {
    return "indeterminate";
  }
  try {
    process.kill(-pid, 0);
    onProbe?.("present");
    if (platform === "linux" && (child.exitCode != null || child.signalCode != null)) {
      if (isLinuxZombieProcessGroup(pid, deadlineAt)) {
        return "dead";
      }
      // The group may be reaped while ps runs. Recheck kernel existence without
      // treating an empty or failed snapshot as proof of completion.
      process.kill(-pid, 0);
    }
    return "live";
  } catch (error) {
    onProbe?.(
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "unknown",
    );
    if (isMissingProcessError(error)) {
      return "dead";
    }
    return errorPolicy === "alive-on-eperm" && hasProcessErrorCode(error, "EPERM")
      ? "live"
      : "indeterminate";
  }
}

function isLinuxZombieProcessGroup(pid: number, deadlineAt?: number): boolean {
  const timeout =
    deadlineAt === undefined
      ? PROCESS_GROUP_DRAIN_TIMEOUT_MS
      : Math.min(PROCESS_GROUP_DRAIN_TIMEOUT_MS, Math.floor(deadlineAt - Date.now()));
  // Snapshot work shares its owner's deadline. Exhaustion is not death, and
  // timeout: 0 would silently remove Node's subprocess timeout.
  if (timeout <= 0) {
    return false;
  }
  // Detached children lead their own session. Linux kill(0) includes zombies,
  // which cannot write or respond to signals while awaiting their parent's reap.
  // Enumerate threads (-L): a process row reports only the group leader's state,
  // and a pthread_exit leader reads Z while sibling threads still run and write.
  const result = spawnSync("ps", ["-s", String(pid), "-L", "-o", "pgid=,state="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout,
    killSignal: "SIGKILL",
  });
  const zombie = new RegExp(`^\\s*${pid}\\s+Z\\s*$`, "u");
  // Missing, failed or unrecognized snapshots never certify completion.
  return (
    !result.error &&
    result.status === 0 &&
    result.stdout
      .trim()
      .split("\n")
      .every((row) => zombie.test(row))
  );
}

export async function waitForManagedProcessGroupExit(
  child: ManagedProcessGroupChild,
  timeoutMs: number,
  {
    clampPollToDeadline = false,
    pollIntervalMs = PROCESS_GROUP_POLL_MS,
    ...groupOptions
  }: ManagedProcessGroupOptions & {
    clampPollToDeadline?: boolean;
    pollIntervalMs?: number;
  },
): Promise<boolean> {
  const deadlineAt = Math.min(Date.now() + timeoutMs, groupOptions.deadlineAt ?? Infinity);
  const boundedGroupOptions = { ...groupOptions, deadlineAt };
  while (Date.now() < deadlineAt) {
    if (inspectManagedProcessGroup(child, boundedGroupOptions) === "dead") {
      return true;
    }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    const waitMs = clampPollToDeadline ? Math.min(pollIntervalMs, remainingMs) : pollIntervalMs;
    await new Promise((resolve) => {
      setTimeout(resolve, waitMs);
    });
  }
  return inspectManagedProcessGroup(child, boundedGroupOptions) === "dead";
}

/** Run a child command while forwarding termination signals to its process group. */
export async function runManagedCommand({
  stdio = "inherit",
  platform = process.platform,
  timeoutMs,
  timeoutKillGraceMs,
  signalKillGraceMs,
  timeoutForceKillOnLeaderExit = false,
  requireProcessTreeExit = false,
  runTaskkill = spawnSync,
  onReady,
  signal,
  abortKillGraceMs,
  cleanupDrainTimeoutMs,
  onSignal,
  ...commandOptions
}: RunManagedCommandOptions) {
  if (platform === "win32" && requireProcessTreeExit) {
    throw Object.assign(
      new Error("Strict managed process-tree verification is not supported on Windows"),
      { code: "EPROCESS_TREE_VERIFICATION_UNSUPPORTED" },
    );
  }
  signal?.throwIfAborted();
  const managedStdio: StdioOptions =
    stdio === "inherit"
      ? ["inherit", "inherit", "inherit"]
      : Array.isArray(stdio)
        ? [...stdio]
        : stdio;
  // Non-TTY inherited output must remain observable when a nested detached
  // wrapper outlives its leader. Preserve terminal descriptors and stream bytes.
  const forwardedOutputs = [process.stdout, process.stderr].map((target, index) => {
    if (
      platform !== "win32" &&
      !target.isTTY &&
      Array.isArray(managedStdio) &&
      managedStdio[index + 1] === "inherit"
    ) {
      managedStdio[index + 1] = "pipe";
      return target;
    }
    return undefined;
  });
  // Preserve spawn's input snapshot while Windows platform code loads.
  const commandEnv = { ...(commandOptions.env ?? process.env) };
  const spawnSpec = createManagedCommandSpawnSpec({
    ...commandOptions,
    args: commandOptions.args?.slice(),
    cwd: commandOptions.cwd ?? process.cwd(),
    env: commandEnv,
    stdio: managedStdio,
    platform,
  });
  const loading = loadManagedChildSpawner(platform);
  const spawnManagedChild = typeof loading === "function" ? loading : await loading;
  signal?.throwIfAborted();
  let releaseClaim = findVitestResourceOwner(
    commandEnv.TMPDIR || commandEnv.TMP || commandEnv.TEMP || tmpdir(),
  )?.claim();
  const releaseOwnership = () => {
    releaseClaim?.();
    releaseClaim = undefined;
  };
  // Register before spawn: a child can become ready before spawn returns.
  installSignalHandlers();
  let child: ChildProcess;
  try {
    child = spawnManagedChild(spawnSpec.command, spawnSpec.args, spawnSpec.options);
  } catch (error) {
    removeSignalHandlersIfIdle();
    releaseOwnership();
    throw error;
  }
  const ownsProcessTree = requireProcessTreeExit || windowsJobs.has(child);
  // Socket.closed can precede its native close callback. Observe real pipe
  // completion before onReady can cancel or otherwise reenter finalization.
  const pendingOutputCloses = new Set([child.stdout, child.stderr].filter((pipe) => pipe != null));
  const removeOutputCloseListeners = [...pendingOutputCloses].map((pipe) => {
    const onClose = () => {
      pendingOutputCloses.delete(pipe);
    };
    pipe.once("close", onClose);
    return () => pipe.off("close", onClose);
  });
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let finalization: Promise<{ type: "failed"; error: unknown } | undefined> | undefined;
  let cancellation: ManagedCommandOutcome | undefined;
  let notifyOutcome!: (outcome: ManagedCommandOutcome) => void;
  const completion = new Promise<ManagedCommandOutcome>((resolve) => {
    notifyOutcome = resolve;
  });
  const finalize = (
    stopSignal?: NodeJS.Signals,
    forceKillDelayMs?: number,
    forceKillOnLeaderExit = false,
  ) => {
    // Observe eager rejection even when cancellation starts inside onReady.
    // Physical release stays in onTerminated: strict cleanup can release, then fail.
    return (finalization ??= finalizeManagedChild(child, stopSignal, {
      platform,
      runTaskkill,
      forceKillDelayMs,
      forceKillOnLeaderExit,
      drainTimeoutMs: cleanupDrainTimeoutMs,
      areOutputPipesClosed: () => pendingOutputCloses.size === 0,
      onTerminated: releaseOwnership,
    }).then(
      () => undefined,
      (error: unknown) => ({ type: "failed" as const, error }),
    ));
  };
  const stop = (outcome: ManagedCommandOutcome, ...termination: Parameters<typeof finalize>) => {
    cancellation ??= outcome;
    clearTimeout(timeoutTimer);
    const joined = finalize(...termination);
    notifyOutcome(cancellation);
    return joined;
  };
  const forwardSignal = (received: NodeJS.Signals) => {
    onSignal?.(received);
    void stop({ type: "signal", signal: received }, received, signalKillGraceMs);
  };
  const abort = () => {
    void stop({ type: "aborted" }, "SIGTERM", abortKillGraceMs);
  };
  managedChildren.add(forwardSignal);
  try {
    child.once("error", (error) => {
      clearTimeout(timeoutTimer);
      if (windowsJobs.has(child)) {
        void stop({ type: "failed", error }, "SIGKILL");
      } else {
        notifyOutcome({ type: "failed", error });
      }
    });
    // The wall deadline includes output drainage, but not group verification after close.
    child.once("close", () => clearTimeout(timeoutTimer));
    // Tree owners must start cleanup at exit: descendants can hold output
    // open indefinitely. Finalization still joins the group and output pipes.
    child.once(ownsProcessTree ? "exit" : "close", (status, received) => {
      notifyOutcome({
        type: "completed",
        exit: received ?? status ?? 1,
      });
    });
    if (timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        void stop({ type: "timeout" }, "SIGTERM", timeoutKillGraceMs, timeoutForceKillOnLeaderExit);
      }, timeoutMs);
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    try {
      for (const [index, target] of forwardedOutputs.entries()) {
        if (target) {
          const output = index === 0 ? child.stdout : child.stderr;
          // Each child owns its pipe listeners; shared stdout/stderr only receive
          // writes. The callback carries target completion and backpressure.
          output!.pipe(
            new Writable({
              write(chunk, encoding, callback) {
                target.write(chunk, encoding, callback);
              },
            }),
          );
        }
      }
      onReady?.(child);
    } catch (error) {
      const cleanup = await stop({ type: "failed", error }, "SIGTERM");
      if (cleanup && cleanup.error !== error) {
        throw createManagedCommandSetupCleanupError(error, cleanup.error);
      }
      throw error;
    }
    let outcome = await completion;
    if (outcome.type === "completed" && ownsProcessTree) {
      // Preserve actual signal cleanup; numeric 143 must still reject lingering descendants.
      const exitSignal = typeof outcome.exit === "string" ? outcome.exit : undefined;
      void finalize(exitSignal);
    }
    // Cleanup failure overrides the first cancellation, including during strict drainage.
    const cleanup = finalization ? await finalization : undefined;
    outcome = cleanup ?? cancellation ?? outcome;
    // Preserve the ordinary API's close-based contract. Cancellation and strict
    // commands release only at the finalizer's positive termination boundary.
    if (outcome.type === "completed" && !ownsProcessTree && !cancellation && !finalization) {
      releaseOwnership();
    }
    if (outcome.type === "failed") {
      throw outcome.error;
    }
    if (outcome.type === "timeout") {
      throw Object.assign(new Error(`Managed command timed out after ${timeoutMs}ms`), {
        code: "ETIMEDOUT",
      });
    }
    if (outcome.type === "aborted") {
      throw Object.assign(new Error("Managed command aborted"), { code: "ABORT_ERR" });
    }
    if (outcome.type === "signal") {
      return signalExitCode(outcome.signal);
    }
    return typeof outcome.exit === "string" ? signalExitCode(outcome.exit) : outcome.exit;
  } finally {
    for (const removeListener of removeOutputCloseListeners) {
      removeListener();
    }
    clearTimeout(timeoutTimer);
    signal?.removeEventListener("abort", abort);
    managedChildren.delete(forwardSignal);
    removeSignalHandlersIfIdle();
    if (!child.pid) {
      releaseOwnership();
    }
  }
}

export async function finalizeManagedChild(
  child: ChildProcess,
  signal: NodeJS.Signals | undefined,
  {
    platform,
    runTaskkill,
    forceKillDelayMs = FORCE_KILL_DELAY_MS,
    forceKillOnLeaderExit = false,
    drainTimeoutMs = PROCESS_GROUP_DRAIN_TIMEOUT_MS,
    retainOutputOnFailure = false,
    areOutputPipesClosed,
    onTerminated = () => {},
  }: {
    platform: NodeJS.Platform;
    runTaskkill: TaskkillRunner;
    forceKillDelayMs?: number;
    forceKillOnLeaderExit?: boolean;
    drainTimeoutMs?: number;
    retainOutputOnFailure?: boolean;
    areOutputPipesClosed?: () => boolean;
    onTerminated?: () => void;
  },
) {
  // Nested wrappers own detached groups. Let them forward the signal before
  // killing their leader, then join inherited pipes as well as our own group.
  // POSIX normal exit has no grace period: surviving group members are a failure.
  const startedAt = Date.now();
  const forceDelay = signal ? forceKillDelayMs : 0;
  // Temporary branch-only diagnosis: no command arguments, paths, or environment values.
  const diagnostic =
    platform === "darwin" && !signal && child.spawnfile === "/usr/bin/lipo"
      ? { events: [] as Array<Record<string, unknown>>, omitted: 0 }
      : undefined;
  const recordDiagnostic = (event: Record<string, unknown>) => {
    if (!diagnostic) return;
    if (diagnostic.events.length < 256) {
      diagnostic.events.push({ elapsedMs: Date.now() - startedAt, ...event });
    } else {
      diagnostic.omitted++;
    }
  };
  const diagnosticCode = (error: unknown) =>
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "unknown";
  let snapshotTaken = false;
  const captureDarwinSnapshot = () => {
    if (!diagnostic || snapshotTaken || !child.pid) return;
    snapshotTaken = true;
    try {
      const snapshotDeadline = Math.min(startedAt + forceDelay + drainTimeoutMs, Date.now() + 500);
      const read = (kind: "processes" | "threads", args: string[]) => {
        const remaining = Math.floor(snapshotDeadline - Date.now());
        if (remaining <= 0) {
          recordDiagnostic({ kind, outcome: "deadline-exhausted" });
          return [];
        }
        const result = spawnSync("/bin/ps", args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: Math.min(250, remaining),
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
        });
        const rows: Array<{ pid: number; ppid: number; pgid: number; uid: number; state: string }> =
          [];
        let malformedRows = 0;
        for (const line of (result.stdout ?? "").split("\n")) {
          if (!line.trim()) continue;
          const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s*$/u.exec(line);
          if (!fields) {
            malformedRows++;
          } else if (Number(fields[3]) === child.pid) {
            rows.push({
              pid: Number(fields[1]),
              ppid: Number(fields[2]),
              pgid: Number(fields[3]),
              uid: Number(fields[4]),
              state: fields[5]!,
            });
          }
        }
        recordDiagnostic({
          kind,
          exitCode: result.status,
          signalCode: result.signal,
          errorCode: result.error ? diagnosticCode(result.error) : null,
          malformedRows,
          rows: rows.slice(0, 64),
          omittedRows: Math.max(0, rows.length - 64),
        });
        return rows;
      };
      const fields = "pid=,ppid=,pgid=,uid=,stat=";
      const rows = read("processes", ["-A", "-o", fields]);
      const pids = [...new Set(rows.map(({ pid }) => pid))].slice(0, 16);
      if (pids.length) {
        read("threads", ["-M", "-p", pids.join(","), "-o", fields]);
      } else {
        recordDiagnostic({ kind: "threads", outcome: "no-observed-owned-pids" });
      }
    } catch (error) {
      recordDiagnostic({ kind: "snapshot-error", errorCode: diagnosticCode(error) });
    }
  };
  const signalErrors: unknown[] = [];
  const recordSignalError = (error: unknown) => {
    if (!isMissingProcessError(error)) {
      signalErrors.push(error);
    }
  };
  const terminationOptions = {
    platform,
    runTaskkill,
    onChildSignalError: (error: unknown) => {
      recordSignalError(error);
      recordDiagnostic({
        kind: "signal-error",
        target: "leader",
        errorCode: diagnosticCode(error),
      });
      captureDarwinSnapshot();
    },
    onProcessGroupSignalError: (error: unknown) => {
      recordSignalError(error);
      recordDiagnostic({ kind: "signal-error", target: "group", errorCode: diagnosticCode(error) });
      captureDarwinSnapshot();
    },
  };
  const job = windowsJobs.get(child);
  const normalJobExit = !signal && job !== undefined;
  const outputClosed =
    areOutputPipesClosed ??
    (() => [child.stdout, child.stderr].every((pipe) => !pipe || pipe.closed));
  let joined = false;
  const failures: unknown[] = [];
  try {
    if (normalJobExit && !outputClosed()) {
      // Give terminal writers half the existing allowance to drain naturally;
      // reserve the rest for Job termination and verified output closure.
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          child.off("close", finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.max(0, startedAt + drainTimeoutMs / 2 - Date.now()));
        child.once("close", finish);
      });
    }
    const initialGroupState = !signal
      ? inspectManagedProcessGroup(child, {
          deadlineAt: startedAt + forceDelay + drainTimeoutMs,
          errorPolicy: "indeterminate",
          platform,
          onProbe: diagnostic
            ? (result) => recordDiagnostic({ kind: "initial-probe", result })
            : undefined,
        })
      : undefined;
    if (diagnostic)
      recordDiagnostic({
        kind: "initial-state",
        groupState: initialGroupState,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        outputClosed: outputClosed(),
      });
    const termination: ManagedChildTermination | undefined =
      initialGroupState === "dead"
        ? { processTreeState: "terminated" }
        : terminateManagedChild(child, signal ?? "SIGKILL", terminationOptions);
    recordDiagnostic({
      kind: "termination-result",
      signal: signal ?? "SIGKILL",
      attempted: initialGroupState !== "dead",
      processTreeState: termination?.processTreeState ?? null,
      errorCode: termination?.error ? diagnosticCode(termination.error) : null,
    });
    if (platform === "win32" && termination?.processTreeState !== "terminated" && !job) {
      throw createManagedCommandCleanupError(
        "Windows taskkill could not verify managed process tree exit",
        child,
        platform,
        "indeterminate",
        termination?.error,
      );
    }
    // Normal Job output drainage shares the original budget. Windows cancellation
    // retains its existing post-taskkill allowance; POSIX probes remain bounded too.
    const forceAt = (platform === "win32" && !normalJobExit ? Date.now() : startedAt) + forceDelay;
    const deadline = forceAt + drainTimeoutMs;
    let forced = !signal || platform === "win32";
    let groupState: "dead" | "indeterminate" | "live" = "indeterminate";
    let survivingPids: number[] | undefined;
    let observationError: Error | undefined;
    let warned = false;
    while (true) {
      const exited = child.exitCode !== null || child.signalCode !== null;
      // A snapshot cannot spend drainage time before escalation is due. Forced
      // leader-exit cleanup skips snapshot work but still checks kernel existence.
      const probeDeadline = forced
        ? deadline
        : forceKillOnLeaderExit && exited
          ? Math.min(forceAt, Date.now())
          : forceAt;
      if (platform === "win32") {
        const observed = observeWindowsTree(child);
        survivingPids = observed.survivingPids;
        observationError = observed.error;
        groupState = observed.processTreeState === "terminated" ? "dead" : "indeterminate";
        if (!warned && groupState !== "dead") {
          warned = true;
          process.emitWarning(
            Object.assign(
              createManagedCommandCleanupError(
                `Windows process tree unresolved: ${JSON.stringify({ survivingPids: survivingPids ?? null, observationError: observed.error?.message })}`,
                child,
                platform,
                "indeterminate",
                termination?.error ?? observed.error,
              ),
              { survivingPids },
            ),
          );
        }
      } else {
        groupState = inspectManagedProcessGroup(child, {
          deadlineAt: probeDeadline,
          errorPolicy: "indeterminate",
          platform,
          onProbe: diagnostic
            ? (result) => recordDiagnostic({ kind: "drain-probe", result })
            : undefined,
        });
      }
      if (diagnostic)
        recordDiagnostic({ kind: "drain-state", groupState, exited, outputClosed: outputClosed() });
      if (groupState === "dead" && exited && outputClosed()) {
        joined = true;
        // A missing group at signal time supersedes the earlier racy liveness probe.
        if (!signal && platform !== "win32" && termination?.processTreeState !== "terminated") {
          const cleanupErrors = [termination?.error, ...signalErrors].filter(
            (error) => error !== undefined,
          );
          throw createManagedCommandCleanupError(
            "Managed command exited while its process group remained active",
            child,
            platform,
            "terminated",
            cleanupErrors.length > 0
              ? new AggregateError(cleanupErrors, "Managed process termination failed")
              : undefined,
          );
        }
        break;
      }
      const now = Date.now();
      // Bounded timeout callers can retire remaining descendants as soon as the
      // leader exits. Other owners retain their configured graceful-drain window.
      if (!forced && (now >= forceAt || (forceKillOnLeaderExit && exited))) {
        forced = true;
        if (groupState !== "dead") {
          terminateManagedChild(child, "SIGKILL", terminationOptions);
        }
      }
      if (now >= deadline) {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(PROCESS_GROUP_POLL_MS, (forced ? deadline : forceAt) - now));
      });
    }
    if (!joined) {
      // Stop owning pipe handles only after recording failure; never disguise an
      // escaped descendant holding stdio as successful completion or cancellation.
      if (!retainOutputOnFailure) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      throw Object.assign(
        createManagedCommandCleanupError(
          `Managed command cleanup could not verify child, process group, and output closure${platform === "win32" ? `: ${JSON.stringify({ survivingPids: survivingPids ?? null })}` : ""}`,
          child,
          platform,
          groupState === "live" ? "live" : "indeterminate",
          new AggregateError(
            [termination?.error, observationError, ...signalErrors].filter(
              (error) => error !== undefined,
            ),
            "Managed process termination or observation failed",
          ),
        ),
        { survivingPids },
      );
    }
  } catch (error) {
    failures.push(error);
    captureDarwinSnapshot();
  }
  if (job) {
    // Closing a kill-on-close Job is recovery, not proof that its members exited.
    // Retain the final outcome before relinquishing the native handle on every path.
    const observed = joined ? undefined : observeWindowsTree(child);
    if (!joined && !hasUnjoinedWork(failures[0])) {
      failures[0] = Object.assign(
        createManagedCommandCleanupError(
          "Windows Job finalization remains unverified",
          child,
          platform,
          "indeterminate",
          failures[0],
        ),
        { survivingPids: observed?.survivingPids },
      );
    }
    if (observed?.error) {
      failures.push(observed.error);
    }
    const receipt: ManagedChildTermination = {
      ...observed,
      processTreeState: joined ? "terminated" : "indeterminate",
      ...(failures.length
        ? { error: new AggregateError(failures, "Managed command finalization failed") }
        : {}),
    };
    windowsTerminations.set(child, receipt);
    try {
      job.close();
      windowsJobs.delete(child);
    } catch (error) {
      joined = false;
      failures.push(
        createManagedCommandCleanupError(
          "Windows Job handle closure failed",
          child,
          platform,
          "indeterminate",
          error,
        ),
      );
      receipt.processTreeState = "indeterminate";
      receipt.error = new AggregateError(failures, "Windows Job finalization failed");
    }
  }
  if (joined) {
    onTerminated();
  }
  if (diagnostic && (failures.length || snapshotTaken)) {
    try {
      console.error(
        `[darwin-managed-cleanup] ${JSON.stringify({
          pid: child.pid,
          processGroupId: child.pid,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
          joined,
          outputClosed: outputClosed(),
          processTreeState: joined ? "terminated" : "indeterminate",
          failureCount: failures.length,
          elapsedMs: Date.now() - startedAt,
          ...diagnostic,
        })}`,
      );
    } catch {
      // Diagnostic output must not replace the managed command's original outcome.
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Managed command finalization failed");
  }
}

function createManagedCommandSetupCleanupError(error: unknown, cleanupError: unknown) {
  return new AggregateError(
    [error, cleanupError],
    "Managed command setup failed and its process tree could not be cleaned up",
    { cause: cleanupError },
  );
}

function createManagedCommandCleanupError(
  message: string,
  child: ManagedProcessGroupChild,
  platform: NodeJS.Platform,
  processTreeState: ProcessTreeState,
  cause?: unknown,
) {
  const processGroupId =
    platform !== "win32" &&
    child.pid !== undefined &&
    Number.isSafeInteger(child.pid) &&
    child.pid > 1
      ? child.pid
      : undefined;
  return Object.assign(new Error(message, { cause }), {
    code: "EPROCESSGROUP_CLEANUP_FAILED",
    ...(platform === "win32" ? { manualRecoveryRequired: true } : {}),
    ...(processGroupId === undefined ? {} : { processGroupId }),
    processTreeState,
  });
}

function installSignalHandlers() {
  for (const signal of FORWARDED_SIGNALS) {
    if (signalHandlers.has(signal)) {
      continue;
    }
    const handler = () => forwardSignalToManagedChildren(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function removeSignalHandlersIfIdle() {
  if (managedChildren.size > 0) {
    return;
  }
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
  signalHandlers.clear();
}

function forwardSignalToManagedChildren(signal: NodeJS.Signals) {
  for (const forward of managedChildren) {
    forward(signal);
  }
}

export function createManagedCommandSpawnSpec(options: ManagedCommandOptions) {
  const { cwd, env, stdio = "inherit", platform = process.platform } = options;
  const { args, command, ...invocationOptions } = createManagedCommandInvocation(options);

  return {
    args,
    command,
    options: {
      cwd,
      env,
      stdio,
      ...invocationOptions,
      detached: platform !== "win32",
    },
  };
}

export function createManagedCommandInvocation({
  bin,
  args = [],
  env,
  platform = process.platform,
  shell = platform === "win32",
  windowsVerbatimArguments,
  comSpec,
}: ManagedCommandOptions) {
  if (platform === "win32" && shell && args.length > 0) {
    return {
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(bin, args)],
      command: comSpec ?? resolveWindowsCmdExePath(env ?? process.env),
      shell: false,
      windowsVerbatimArguments: true,
    };
  }

  return {
    args,
    command: bin,
    shell,
    windowsVerbatimArguments,
  };
}

function signalNumberFor(signal: NodeJS.Signals) {
  switch (signal) {
    case "SIGHUP":
      return 1;
    case "SIGINT":
      return 2;
    case "SIGTERM":
      return 15;
    default:
      return osConstants.signals?.[signal] ?? 0;
  }
}

function isMissingProcessError(error: unknown) {
  return hasProcessErrorCode(error, "ESRCH");
}

function hasProcessErrorCode(error: unknown, code: string) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
