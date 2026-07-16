import type { ChildProcess } from "node:child_process";

type TerminateGoogleMeetBridgeProcessOptions = {
  graceMs: number;
  forceKillWaitMs?: number;
  initialSignal?: NodeJS.Signals;
};

function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode != null || proc.signalCode != null;
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(proc)) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      proc.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(hasExited(proc)), timeoutMs);
    timeout.unref?.();
    proc.once("exit", onExit);
    if (hasExited(proc)) {
      finish(true);
    }
  });
}

/** Resolve only after the child exits or the bounded force-kill sequence finishes. */
export async function terminateGoogleMeetBridgeProcess(
  proc: ChildProcess | undefined,
  options: TerminateGoogleMeetBridgeProcessOptions,
): Promise<void> {
  if (!proc || hasExited(proc)) {
    return;
  }
  const initialSignal = options.initialSignal ?? "SIGTERM";
  try {
    if (!proc.kill(initialSignal)) {
      return;
    }
  } catch {
    return;
  }
  const forceKillWaitMs = options.forceKillWaitMs ?? 1_000;
  if (initialSignal === "SIGKILL") {
    await waitForExit(proc, forceKillWaitMs);
    return;
  }
  if (await waitForExit(proc, options.graceMs)) {
    return;
  }
  try {
    if (!proc.kill("SIGKILL")) {
      return;
    }
  } catch {
    return;
  }
  await waitForExit(proc, forceKillWaitMs);
}
