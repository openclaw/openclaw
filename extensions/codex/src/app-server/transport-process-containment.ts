import {
  isDeadProcessState,
  ProcessInspectionError,
  readCodexAppServerProcess,
  readCodexAppServerProcessSnapshot,
  type PosixProcess,
} from "./transport-process-snapshot.js";

type ContainableTransport = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: string | null;
  kill?: (signal?: NodeJS.Signals) => unknown;
};

export type CodexAppServerProcessIdentity = Pick<PosixProcess, "pid" | "pgid" | "startedAt">;

const MAX_CONTAINED_PROCESSES = 512;
const MAX_PROCESS_CONTAINMENT_MS = 2_000;
const MAX_PROCESS_QUIESCE_PASSES = 16;
const heldStoppedRoots = new Map<
  PosixProcess,
  { child: ContainableTransport; stoppedDescendants: ReadonlyMap<string, PosixProcess> }
>();

// A stopped process never observes its owner exiting: it is reparented and stays
// stopped forever. Release held processes when the owner exits mid-containment.
function releaseHeldProcessesOnExit(): void {
  for (const [root, { child, stoppedDescendants }] of heldStoppedRoots) {
    // Same release as the failure unwind: a stopped, unkilled descendant cannot be
    // reaped, and a resumed native server exits on stdin EOF. The root kill below
    // reaches only its own group, or the root alone when it shares the owner's.
    for (const descendant of stoppedDescendants.values()) {
      signalProcess(descendant.pid, "SIGCONT");
    }
    // An unreaped direct child still owns its PID.
    if (child.exitCode == null && child.signalCode == null) {
      signalProcess(root.pgid === root.pid ? -root.pid : root.pid, "SIGKILL");
    }
  }
}

function holdStoppedRoot(
  root: PosixProcess,
  child: ContainableTransport,
  stoppedDescendants: ReadonlyMap<string, PosixProcess>,
): () => void {
  if (heldStoppedRoots.size === 0) {
    process.on("exit", releaseHeldProcessesOnExit);
  }
  heldStoppedRoots.set(root, { child, stoppedDescendants });
  return () => {
    if (heldStoppedRoots.delete(root) && heldStoppedRoots.size === 0) {
      process.off("exit", releaseHeldProcessesOnExit);
    }
  };
}

/** Discharges the registered root obligation, including an already-obsolete PID. */
export async function terminateCodexAppServerOrphan(
  expected: CodexAppServerProcessIdentity,
): Promise<boolean> {
  const deadline = performance.now() + MAX_PROCESS_CONTAINMENT_MS;
  // A retired root needs only identity evidence; unrelated processes cannot
  // make its durable registration live again or restore its former ancestry.
  const initial = (await readCodexAppServerProcessSnapshot(deadline, [expected.pid])).find(
    (row) => row.pid === expected.pid,
  );
  if (!initial || !hasSameIdentity(initial, expected) || isDeadProcessState(initial.state)) {
    return true;
  }
  const result = await terminateCodexAppServerDescendants(
    { pid: expected.pid, kill: (signal) => signalProcess(expected.pid, signal ?? "SIGTERM") },
    { expected, deadline },
  );
  const contained = result === "exited" ? undefined : result;
  let gone = false;
  try {
    if (contained) {
      const current = await readCodexAppServerProcess(expected.pid, deadline).catch(
        () => undefined,
      );
      if (current && isSameLiveRoot(current, contained.root, true)) {
        // Keep the verified leader stopped until its whole group is killed;
        // a QA-owned child may share its parent's group and must use its PID.
        signalProcess(current.pgid === current.pid ? -current.pid : current.pid, "SIGKILL");
      }
    }
    while (performance.now() < deadline) {
      const snapshot = await readCodexAppServerProcessSnapshot(deadline, [expected.pid]).catch(
        () => undefined,
      );
      if (snapshot?.some((row) => row.pid === process.pid)) {
        const current = snapshot.find((row) => row.pid === expected.pid);
        if (!current || !hasSameIdentity(current, expected) || isDeadProcessState(current.state)) {
          gone = true;
          return true;
        }
      }
      if (!contained) {
        return false;
      }
      // macOS hides a killed process's topology until it is gone. Failed
      // inspection proves neither exit nor survival, so observe again.
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    return false;
  } finally {
    if (contained && !gone) {
      await signalSameProcess(
        contained.root,
        "SIGCONT",
        { deadline: performance.now() + MAX_PROCESS_CONTAINMENT_MS },
        "root",
      );
    }
  }
}

type InspectionBudget = { deadline: number; startRecovery?: () => number };

function extendInspection(budget: InspectionBudget): boolean {
  if (!budget.startRecovery) {
    return false;
  }
  // Keep custody and all observed identities. The transport bounds recovery
  // and starts each caller's exit wait when inspection needs more time.
  budget.deadline = Math.min(
    budget.startRecovery(),
    performance.now() + MAX_PROCESS_CONTAINMENT_MS,
  );
  budget.startRecovery = undefined;
  return performance.now() < budget.deadline;
}

function hasInspectionTime(budget: InspectionBudget): boolean {
  return performance.now() < budget.deadline || extendInspection(budget);
}

async function inspectDuringContainment<T>(
  budget: InspectionBudget,
  read: (deadline: number) => Promise<T>,
): Promise<T | undefined> {
  try {
    return await read(budget.deadline);
  } catch (error) {
    if (
      !(error instanceof ProcessInspectionError) ||
      error.reason !== "deadline" ||
      !extendInspection(budget)
    ) {
      return undefined;
    }
    return await read(budget.deadline).catch(() => undefined);
  }
}

export async function terminateCodexAppServerDescendants(
  child: ContainableTransport,
  {
    expected,
    deadline: initialDeadline,
    startRecovery,
  }: {
    expected?: CodexAppServerProcessIdentity;
    deadline?: number;
    startRecovery?: () => number;
  } = {},
): Promise<{ root: PosixProcess; resume: () => void } | "exited" | undefined> {
  const rootPid = child.pid;
  if (child.exitCode != null || child.signalCode != null) {
    return "exited";
  }
  if (process.platform === "win32" || !rootPid || !child.kill) {
    return undefined;
  }
  // Inspection failures never grant containment or signal authority.
  const budget = {
    deadline: initialDeadline ?? performance.now() + MAX_PROCESS_CONTAINMENT_MS,
    startRecovery: process.platform === "linux" && !expected ? startRecovery : undefined,
  };
  const snapshot = await inspectDuringContainment(budget, (deadline) =>
    readCodexAppServerProcessSnapshot(deadline, undefined, [rootPid]),
  );
  if (!snapshot || !hasInspectionTime(budget)) {
    return undefined;
  }
  const root = snapshot.find((row) => row.pid === rootPid);
  // A retained direct child cannot have its PID reused before Node reaps it.
  // Preserve an OS-observed exit even when Node's exit callback is still queued.
  if (!expected && (!root || isDeadProcessState(root.state))) {
    return "exited";
  }
  if (
    !root ||
    !(expected ? isSameLiveProcess(root, expected) : root.ppid === process.pid) ||
    isDeadProcessState(root.state)
  ) {
    return undefined;
  }

  const initialDescendants = collectDescendants(snapshot, [rootPid]);
  if (initialDescendants.length > MAX_CONTAINED_PROCESSES) {
    return undefined;
  }
  const stoppedDescendants = new Map<string, PosixProcess>();
  // Hold before the awaited SIGSTOP; process.exit can land in any await below.
  // Orphans lack an unreaped handle, so their durable registration keeps cleanup.
  // An owner SIGKILL runs no exit handler; that remains the accepted gap.
  const release = expected ? undefined : holdStoppedRoot(root, child, stoppedDescendants);
  if (!(await signalSameProcess(root, "SIGSTOP", budget, "root"))) {
    release?.();
    return undefined;
  }
  let resumeRootOnUnwind = true;
  try {
    const descendants = await quiesceDescendants(
      root,
      initialDescendants,
      stoppedDescendants,
      budget,
    );
    if (!descendants) {
      return undefined;
    }

    // Parents are last: every destructive signal revalidates the exact live PID
    // while the stopped ancestry still prevents new descendants.
    for (const descendant of descendants.toReversed()) {
      if (!hasInspectionTime(budget)) {
        return undefined;
      }
      const killed =
        isDeadProcessState(descendant.state) ||
        (await signalSameProcess(descendant, "SIGKILL", budget));
      if (killed) {
        // Dead or killed PIDs can be reaped and reused; never release them later.
        stoppedDescendants.delete(identityKey(descendant));
      }
      if (!killed || !hasInspectionTime(budget)) {
        return undefined;
      }
    }
    // SIGKILL can remain pending for an uninterruptible process. Keep the root
    // stopped until every retained identity is observed gone, replaced or dead.
    const remaining = new Map(descendants.map((row) => [row.pid, row]));
    while (remaining.size > 0) {
      const terminationSnapshot = await inspectDuringContainment(budget, (deadline) =>
        readCodexAppServerProcessSnapshot(deadline, [root.pid, ...remaining.keys()]),
      );
      if (!hasInspectionTime(budget)) {
        return undefined;
      }
      if (!terminationSnapshot) {
        // A just-killed descendant can be briefly uninspectable on macOS; the
        // stopped root keeps custody, so observe again until the deadline.
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
        continue;
      }
      const currentRoot = terminationSnapshot.find((row) => row.pid === root.pid);
      if (!currentRoot || !isSameLiveRoot(currentRoot, root, true)) {
        return undefined;
      }
      const currentByPid = new Map(terminationSnapshot.map((row) => [row.pid, row]));
      for (const [pid, retained] of remaining) {
        const current = currentByPid.get(pid);
        if (!current || !hasSameIdentity(current, retained) || isDeadProcessState(current.state)) {
          remaining.delete(pid);
        }
      }
      if (remaining.size > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      }
    }
    resumeRootOnUnwind = false;
    let resumed = false;
    return {
      root,
      resume: () => {
        if (resumed) {
          return;
        }
        resumed = true;
        resumeTransportRoot(child, root, false);
        release?.();
      },
    };
  } finally {
    if (resumeRootOnUnwind) {
      if (expected) {
        // Orphans have no retained child handle. Failed inspection leaves the
        // registration intact; never release a reused PID while unwinding.
        const releaseBudget = { deadline: performance.now() + MAX_PROCESS_CONTAINMENT_MS };
        for (const descendant of stoppedDescendants.values()) {
          await signalSameProcess(descendant, "SIGCONT", releaseBudget);
        }
        await signalSameProcess(root, "SIGCONT", releaseBudget, "root");
      } else {
        // A live parent still owns these stopped children when inspection fails.
        for (const descendant of stoppedDescendants.values()) {
          signalProcess(descendant.pid, "SIGCONT");
        }
        resumeTransportRoot(child, root, true);
      }
      release?.();
    }
  }
}

async function quiesceDescendants(
  root: PosixProcess,
  initialDescendants: PosixProcess[],
  stopped: Map<string, PosixProcess>,
  budget: InspectionBudget,
): Promise<PosixProcess[] | undefined> {
  const provenByPid = new Map(initialDescendants.map((descendant) => [descendant.pid, descendant]));
  const stopFailures = new Map<string, number>();
  for (let pass = 0; pass < MAX_PROCESS_QUIESCE_PASSES; pass += 1) {
    if (!hasInspectionTime(budget)) {
      return undefined;
    }
    if (process.platform === "linux") {
      // A running root makes the topology unusable for this pass. Inspect only
      // its PID until it quiesces, then discover any newly forked descendants.
      const current = await inspectDuringContainment(budget, (deadline) =>
        readCodexAppServerProcess(root.pid, deadline),
      );
      if (!current || !isSameLiveRoot(current, root)) {
        return undefined;
      }
      if (!isQuiescedState(current.state)) {
        if (!signalProcess(current.pid, "SIGSTOP")) {
          return undefined;
        }
        continue;
      }
    }
    const snapshot = await inspectDuringContainment(budget, (deadline) =>
      readCodexAppServerProcessSnapshot(deadline, undefined, [root.pid, ...provenByPid.keys()]),
    );
    if (!snapshot || !hasInspectionTime(budget)) {
      return undefined;
    }
    const currentRoot = snapshot.find((row) => row.pid === root.pid);
    if (!currentRoot || !isSameLiveRoot(currentRoot, root)) {
      return undefined;
    }
    if (!isSameLiveRoot(currentRoot, root, true)) {
      if (
        !(await signalSameProcess(root, "SIGSTOP", budget, "root")) ||
        !hasInspectionTime(budget)
      ) {
        return undefined;
      }
      continue;
    }
    const snapshotByPid = new Map(snapshot.map((process) => [process.pid, process]));
    for (const proven of provenByPid.values()) {
      const current = snapshotByPid.get(proven.pid);
      if (!current) {
        provenByPid.delete(proven.pid);
        stopped.delete(identityKey(proven));
        continue;
      }
      if (!hasSameIdentity(proven, current)) {
        return undefined;
      }
      provenByPid.set(current.pid, current);
      const key = identityKey(current);
      if (stopped.has(key)) {
        stopped.set(key, current);
      }
    }
    const descendants = collectDescendants(snapshot, [root.pid, ...provenByPid.keys()]);
    for (const descendant of descendants) {
      const proven = provenByPid.get(descendant.pid);
      if (proven && !hasSameIdentity(proven, descendant)) {
        return undefined;
      }
      provenByPid.set(descendant.pid, descendant);
    }
    if (provenByPid.size > MAX_CONTAINED_PROCESSES) {
      return undefined;
    }
    let allStopped = true;
    for (const descendant of provenByPid.values()) {
      if (!hasInspectionTime(budget)) {
        return undefined;
      }
      if (isStoppedState(descendant.state)) {
        continue;
      }
      const stopQueued = await signalSameProcess(descendant, "SIGSTOP", budget);
      if (!hasInspectionTime(budget)) {
        return undefined;
      }
      if (stopQueued) {
        stopFailures.delete(identityKey(descendant));
        stopped.set(identityKey(descendant), descendant);
      } else {
        const key = identityKey(descendant);
        const failures = (stopFailures.get(key) ?? 0) + 1;
        if (failures >= 2) {
          return undefined;
        }
        stopFailures.set(key, failures);
      }
      if (!isUninterruptibleState(descendant.state) || !stopQueued) {
        allStopped = false;
      }
    }
    if (allStopped) {
      return [...provenByPid.values()];
    }
  }
  return undefined;
}

function collectDescendants(snapshot: PosixProcess[], rootPids: number[]): PosixProcess[] {
  const childrenByParent = new Map<number, PosixProcess[]>();
  for (const row of snapshot) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row);
    childrenByParent.set(row.ppid, children);
  }
  const descendants: PosixProcess[] = [];
  const pending = [...new Set(rootPids)];
  const seen = new Set(pending);
  for (const parentPid of pending) {
    for (const child of childrenByParent.get(parentPid) ?? []) {
      if (seen.has(child.pid)) {
        continue;
      }
      seen.add(child.pid);
      descendants.push(child);
      pending.push(child.pid);
    }
  }
  return descendants;
}

function isStoppedState(state: string): boolean {
  return state.startsWith("T") || state.startsWith("t") || isDeadProcessState(state);
}

function isQuiescedState(state: string): boolean {
  return isStoppedState(state) || isUninterruptibleState(state);
}

function isUninterruptibleState(state: string): boolean {
  return state.startsWith("D") || state.startsWith("U");
}

function isSameLiveProcess(
  current: PosixProcess,
  expected: CodexAppServerProcessIdentity,
): boolean {
  return (
    current.pgid === expected.pgid &&
    !isDeadProcessState(current.state) &&
    hasSameIdentity(current, expected)
  );
}

function isSameLiveRoot(
  current: PosixProcess,
  expected: PosixProcess,
  requireStopped = false,
): boolean {
  return (
    current.ppid === expected.ppid &&
    (!requireStopped || isQuiescedState(current.state)) &&
    isSameLiveProcess(current, expected)
  );
}

function resumeTransportRoot(
  child: ContainableTransport,
  root: PosixProcess,
  allowSynchronousPidFallback: boolean,
): void {
  try {
    if (child.kill) {
      child.kill("SIGCONT");
      return;
    }
  } catch {
    if (!allowSynchronousPidFallback) {
      return;
    }
  }
  if (allowSynchronousPidFallback) {
    // Failure unwind has not crossed an asynchronous boundary, so the saved
    // PID is still bounded to this synchronous stopped-root custody window.
    signalProcess(root.pid, "SIGCONT");
  }
}

async function signalSameProcess(
  expected: PosixProcess,
  signal: NodeJS.Signals,
  budget: InspectionBudget,
  identity: "root" | "descendant" = "descendant",
): Promise<boolean> {
  // Portable Node POSIX signals are PID-based, so never retain numeric authority:
  // take this final identity snapshot synchronously immediately before every signal.
  const current = await inspectDuringContainment(budget, (deadline) =>
    readCodexAppServerProcess(expected.pid, deadline),
  );
  const matches = identity === "root" ? isSameLiveRoot : isSameLiveProcess;
  return Boolean(current && matches(current, expected) && signalProcess(current.pid, signal));
}

function hasSameIdentity(
  left: CodexAppServerProcessIdentity,
  right: CodexAppServerProcessIdentity,
): boolean {
  return identityKey(left) === identityKey(right);
}

function identityKey(row: CodexAppServerProcessIdentity): string {
  return `${row.pid}\0${row.startedAt}`;
}

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}
