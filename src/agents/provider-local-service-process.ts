import type { ChildProcess } from "node:child_process";
import { sleepWithAbort } from "@openclaw/retry";
import { isChildProcessTreeAlive, signalChildProcessTree } from "../process/child-process-tree.js";

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const PROCESS_TREE_EXIT_POLL_MS = 25;

export type ManagedLocalServiceProcess = {
  child: ChildProcess;
  closed: boolean;
  windowsRootGone?: boolean;
  pendingSignals: Set<"SIGTERM" | "SIGKILL">;
};

export function trackLocalServiceProcess(child: ChildProcess): ManagedLocalServiceProcess {
  const owned: ManagedLocalServiceProcess = { child, closed: false, pendingSignals: new Set() };
  child.once("close", () => {
    owned.closed = true;
  });
  return owned;
}

function unrefLocalServiceOutput(stream: ChildProcess["stdout"]): void {
  // SAFETY: Child stdio exposes an optional native-handle unref omitted by Readable's types.
  (stream as { unref?: () => void } | null)?.unref?.();
}

export function drainLocalServiceOutput(child: ChildProcess): void {
  child.stdout?.removeAllListeners("data");
  child.stderr?.removeAllListeners("data");
  child.stdout?.resume();
  child.stderr?.resume();
  unrefLocalServiceOutput(child.stdout);
  unrefLocalServiceOutput(child.stderr);
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
  owned.pendingSignals.add(signal);
  try {
    signalChildProcessTree(owned.child, signal, () => owned.pendingSignals.delete(signal));
  } catch (error) {
    owned.pendingSignals.delete(signal);
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
  const gracefulDeadline = Date.now() + DEFAULT_PROBE_TIMEOUT_MS;
  if (owned.pendingSignals.size === 0) {
    signalLocalServiceProcess(owned, "SIGTERM");
  }
  await waitForChildProcessTreeExit(owned, gracefulDeadline);
  if (!isLocalServiceProcessSettled(owned)) {
    const forceDeadline = Date.now() + DEFAULT_PROBE_TIMEOUT_MS;
    signalLocalServiceProcess(owned, "SIGKILL");
    await waitForChildProcessTreeExit(owned, forceDeadline);
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
    const remainingMs = deadline - Date.now();
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
