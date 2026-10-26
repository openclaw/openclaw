import type { ChildProcess } from "node:child_process";
import { sleepWithAbort } from "@openclaw/retry";
import { isChildProcessTreeAlive, signalChildProcessTree } from "../process/child-process-tree.js";
import { createDeferredCore } from "../shared/deferred.js";

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const PROCESS_TREE_EXIT_POLL_MS = 25;

export type ManagedLocalServiceProcess = {
  child: ChildProcess;
  closed: boolean;
  windowsRootGone?: boolean;
  pendingSignals: Map<"SIGTERM" | "SIGKILL", Promise<void>>;
};

export function trackLocalServiceProcess(child: ChildProcess): ManagedLocalServiceProcess {
  const owned: ManagedLocalServiceProcess = { child, closed: false, pendingSignals: new Map() };
  child.once("close", () => {
    owned.closed = true;
  });
  return owned;
}

export function unrefLocalServiceOutput(child: ChildProcess): void {
  for (const stream of [child.stdout, child.stderr]) {
    // SAFETY: Child stdio exposes an optional native-handle unref omitted by Readable's types.
    (stream as { unref?: () => void } | null)?.unref?.();
  }
}

export function drainLocalServiceOutput(child: ChildProcess): void {
  child.stdout?.removeAllListeners("data");
  child.stderr?.removeAllListeners("data");
  child.stdout?.resume();
  child.stderr?.resume();
  unrefLocalServiceOutput(child);
}

function isLocalServiceProcessTreeAlive(owned: ManagedLocalServiceProcess): boolean {
  const windows = process.platform === "win32";
  if (windows && (owned.windowsRootGone || hasLocalServiceProcessExited(owned.child))) {
    owned.windowsRootGone = true;
    return false;
  }
  const alive = isChildProcessTreeAlive(owned.child);
  if (windows && !alive) {
    // A later live numeric PID cannot restore authority over the original child.
    owned.windowsRootGone = true;
  }
  return alive;
}

function isLocalServiceProcessSettled(owned: ManagedLocalServiceProcess): boolean {
  return owned.closed && owned.pendingSignals.size === 0 && !isLocalServiceProcessTreeAlive(owned);
}

function signalLocalServiceProcess(
  owned: ManagedLocalServiceProcess,
  signal: "SIGTERM" | "SIGKILL",
) {
  if (owned.pendingSignals.has(signal) || !isLocalServiceProcessTreeAlive(owned)) {
    return;
  }
  const completion = createDeferredCore();
  owned.pendingSignals.set(signal, completion.promise);
  const complete = () => {
    owned.pendingSignals.delete(signal);
    completion.resolve();
  };
  try {
    signalChildProcessTree(owned.child, signal, complete);
  } catch (error) {
    complete();
    throw error;
  }
}

export function forceStopLocalServiceProcess(owned: ManagedLocalServiceProcess): void {
  if (!isLocalServiceProcessTreeAlive(owned)) {
    return;
  }
  drainLocalServiceOutput(owned.child);
  signalLocalServiceProcess(owned, "SIGKILL");
}

export async function stopLocalServiceProcess(owned: ManagedLocalServiceProcess): Promise<void> {
  if (isLocalServiceProcessSettled(owned)) {
    return;
  }
  drainLocalServiceOutput(owned.child);
  // Grace and final-exit budgets are consumed by sleepWithAbort polls on the
  // monotonic clock; the deadlines must live there too, or a wall-clock step
  // (NTP correction, VM resume) stretches the stop window past its bound.
  const gracefulDeadline = performance.now() + DEFAULT_PROBE_TIMEOUT_MS;
  if (owned.pendingSignals.size === 0) {
    signalLocalServiceProcess(owned, "SIGTERM");
  }
  await waitForChildProcessTreeExit(owned, gracefulDeadline);
  if (!isLocalServiceProcessSettled(owned)) {
    signalLocalServiceProcess(owned, "SIGKILL");
    // Windows taskkill owns its bounded completion deadline. Join every helper
    // before timing final exit observation, even if the service already closed.
    await Promise.all(owned.pendingSignals.values());
    await waitForChildProcessTreeExit(owned, performance.now() + DEFAULT_PROBE_TIMEOUT_MS);
  }
  if (!isLocalServiceProcessSettled(owned)) {
    throw new Error(`Local model service process tree ${owned.child.pid} did not stop`);
  }
}

async function waitForChildProcessTreeExit(
  owned: ManagedLocalServiceProcess,
  deadline: number,
): Promise<void> {
  while (!isLocalServiceProcessSettled(owned)) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      return;
    }
    await sleepWithAbort(Math.min(PROCESS_TREE_EXIT_POLL_MS, remainingMs));
  }
}

/** Return whether a child process has already reported an exit code or signal. */
export function hasLocalServiceProcessExited(
  child: Pick<ChildProcess, "exitCode" | "signalCode">,
): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
