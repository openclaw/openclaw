// Gateway Bench Child script supports OpenClaw repository automation.
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const TEARDOWN_GRACE_MS = 2_000;
const TEARDOWN_KILL_GRACE_MS = 1_000;
const EXIT_POLL_MS = 10;

export type ChildExit = {
  exitCode: number | null;
  signal: string | null;
};

export type StopChildResult = ChildExit & {
  exitedBeforeTeardown: boolean;
};

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function stopChild(
  child: ChildProcessWithoutNullStreams,
  options: { killGraceMs?: number; teardownGraceMs?: number } = {},
): Promise<StopChildResult> {
  const teardownGraceMs = options.teardownGraceMs ?? TEARDOWN_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? TEARDOWN_KILL_GRACE_MS;
  let observedExit: ChildExit | null = null;
  const directExit = (): ChildExit | null =>
    observedExit ??
    (child.exitCode != null || child.signalCode != null
      ? { exitCode: child.exitCode, signal: child.signalCode }
      : null);
  const currentExit = (): ChildExit | null => {
    const exit = directExit();
    if (exit == null || isProcessTreeAlive(child)) {
      return null;
    }
    return exit;
  };
  const waitForProcessTreeExit = async (ms: number): Promise<boolean> => {
    const deadlineAt = Date.now() + ms;
    while (Date.now() < deadlineAt) {
      if (!isProcessTreeAlive(child)) {
        return true;
      }
      await delay(Math.min(EXIT_POLL_MS, deadlineAt - Date.now()));
    }
    return !isProcessTreeAlive(child);
  };
  const cleanupExitedProcessTree = async (
    exit: ChildExit,
    exitedBeforeTeardown: boolean,
  ): Promise<StopChildResult> => {
    if (!isProcessTreeAlive(child)) {
      return { ...exit, exitedBeforeTeardown };
    }
    const sentTeardownSignal = killProcessTree(child, "SIGTERM");
    if (sentTeardownSignal) {
      await waitForProcessTreeExit(teardownGraceMs);
    }
    if (sentTeardownSignal && isProcessTreeAlive(child)) {
      killProcessTree(child, "SIGKILL");
      await waitForProcessTreeExit(killGraceMs);
    }
    if (!sentTeardownSignal) {
      releaseUnsettledChild(child);
    }
    return { ...exit, exitedBeforeTeardown };
  };

  const existingExit = directExit();
  if (existingExit != null) {
    return await cleanupExitedProcessTree(existingExit, true);
  }

  const exited = new Promise<ChildExit>((resolve) => {
    child.once("exit", (exitCode, signal) => {
      observedExit = { exitCode, signal };
      resolve(observedExit);
    });
  });
  const waitForExit = async (ms: number): Promise<ChildExit | null> => {
    const deadlineAt = Date.now() + ms;
    while (Date.now() < deadlineAt) {
      const waitMs = Math.min(EXIT_POLL_MS, deadlineAt - Date.now());
      if (directExit() == null) {
        await Promise.race([exited, delay(waitMs)]);
      } else {
        await delay(waitMs);
      }
      const exit = currentExit();
      if (exit != null) {
        return exit;
      }
    }
    return currentExit();
  };

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const queuedExit = directExit();
  if (queuedExit != null) {
    return await cleanupExitedProcessTree(queuedExit, true);
  }

  const sentTeardownSignal = killProcessTree(child, "SIGTERM");
  const gracefulExit = await waitForExit(teardownGraceMs);
  if (gracefulExit != null) {
    return { ...gracefulExit, exitedBeforeTeardown: !sentTeardownSignal };
  }

  const postGraceExit = currentExit();
  if (postGraceExit != null) {
    return { ...postGraceExit, exitedBeforeTeardown: !sentTeardownSignal };
  }
  if (!sentTeardownSignal) {
    releaseUnsettledChild(child);
    return { exitCode: null, exitedBeforeTeardown: true, signal: null };
  }

  killProcessTree(child, "SIGKILL");
  const killedExit = await waitForExit(killGraceMs);
  const finalExit = killedExit ?? currentExit();
  if (finalExit != null) {
    return { ...finalExit, exitedBeforeTeardown: false };
  }

  releaseUnsettledChild(child);
  return { exitCode: null, exitedBeforeTeardown: false, signal: "SIGKILL" };
}

function releaseUnsettledChild(child: ChildProcessWithoutNullStreams): void {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
}

function isProcessTreeAlive(child: ChildProcessWithoutNullStreams): boolean {
  if (process.platform === "win32" || child.pid === undefined) {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return isProcessStillExistsError(error);
  }
}

function isProcessStillExistsError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "EPERM";
}

function killProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // Fall back to the direct child below.
    }
  }
  return child.kill(signal);
}
