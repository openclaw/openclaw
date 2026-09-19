// Gateway Bench Child script supports OpenClaw repository automation.
import type { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  inspectManagedProcessGroup,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "./managed-child-process.mts";
import { sleep as delay } from "./sleep.mjs";

export { delay };

const TEARDOWN_GRACE_MS = 2_000;
const TEARDOWN_KILL_GRACE_MS = 1_000;
const EXIT_POLL_MS = 10;

type ChildExit = {
  exitCode: number | null;
  signal: string | null;
};

export type StopChildResult = ChildExit & {
  exitedBeforeTeardown: boolean;
};

type StopChildOptions = {
  killGraceMs?: number;
  teardownGraceMs?: number;
};

/** Acknowledgment and close prove Gateway cleanup; forced tree cleanup is a separate outcome. */
export async function stopGatewayGracefully(child: ChildProcess, timeoutMs: number) {
  const startedAt = performance.now();
  if (!child.connected || child.exitCode !== null || child.signalCode !== null) {
    throw new Error("Gateway exited or disconnected before graceful shutdown");
  }
  let acknowledgment: { accepted: boolean; compileCacheDir: string | null } | undefined;
  return await new Promise<{
    ms: number;
    acknowledgment: { accepted: boolean; compileCacheDir: string | null };
  }>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("close", onClose);
      child.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "openclaw-startup-benchmark:stopping" &&
        "accepted" in message &&
        typeof message.accepted === "boolean" &&
        "compileCacheDir" in message &&
        (message.compileCacheDir === null || typeof message.compileCacheDir === "string")
      ) {
        acknowledgment = { accepted: message.accepted, compileCacheDir: message.compileCacheDir };
        if (!acknowledgment.accepted) {
          onError(new Error("Gateway has no graceful SIGINT handler"));
        }
      }
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      if (code !== 0 || signal !== null || acknowledgment?.accepted !== true) {
        reject(
          new Error(
            `Gateway shutdown was not acknowledged and clean: ${JSON.stringify({ code, signal, acknowledgment })}`,
          ),
        );
      } else {
        resolve({ ms: performance.now() - startedAt, acknowledgment });
      }
    };
    const timer = setTimeout(
      () =>
        onError(
          new Error(
            `Gateway graceful shutdown deadline exceeded: ${JSON.stringify({ acknowledgment })}`,
          ),
        ),
      timeoutMs,
    );
    child.on("message", onMessage);
    child.once("close", onClose);
    child.once("error", onError);
    child.send("openclaw-startup-benchmark:stop", (error) => {
      if (error) {
        onError(error);
      }
    });
  });
}

export async function stopChild(
  child: ChildProcess,
  options: StopChildOptions = {},
): Promise<StopChildResult> {
  const teardownGraceMs = options.teardownGraceMs ?? TEARDOWN_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? TEARDOWN_KILL_GRACE_MS;
  const processTreeAlive = () =>
    inspectManagedProcessGroup(child, { errorPolicy: "alive-on-eperm" }) === "live";
  const signalProcessTree = (signal: NodeJS.Signals): boolean => {
    let delivered = true;
    terminateManagedChild(
      {
        kill(childSignal) {
          delivered = child.kill(childSignal);
          return delivered;
        },
        pid: child.pid,
      },
      signal,
      {
        onChildSignalError(error) {
          throw error;
        },
        taskkillTimeoutMs: null,
      },
    );
    return delivered;
  };
  let observedExit: ChildExit | null = null;
  const directExit = (): ChildExit | null =>
    observedExit ??
    (child.exitCode != null || child.signalCode != null
      ? { exitCode: child.exitCode, signal: child.signalCode }
      : null);
  const currentExit = (): ChildExit | null => {
    const exit = directExit();
    if (exit == null || processTreeAlive()) {
      return null;
    }
    return exit;
  };
  const waitForProcessTreeExit = (ms: number): Promise<boolean> =>
    waitForManagedProcessGroupExit(child, ms, {
      clampPollToDeadline: true,
      errorPolicy: "alive-on-eperm",
      pollIntervalMs: EXIT_POLL_MS,
    });
  const cleanupExitedProcessTree = async (
    exit: ChildExit,
    exitedBeforeTeardown: boolean,
  ): Promise<StopChildResult> => {
    if (!processTreeAlive()) {
      return { ...exit, exitedBeforeTeardown };
    }
    const sentTeardownSignal = signalProcessTree("SIGTERM");
    if (sentTeardownSignal) {
      await waitForProcessTreeExit(teardownGraceMs);
    }
    if (sentTeardownSignal && processTreeAlive()) {
      signalProcessTree("SIGKILL");
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

  const sentTeardownSignal = signalProcessTree("SIGTERM");
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

  signalProcessTree("SIGKILL");
  const killedExit = await waitForExit(killGraceMs);
  const finalExit = killedExit ?? currentExit();
  if (finalExit != null) {
    return { ...finalExit, exitedBeforeTeardown: false };
  }

  releaseUnsettledChild(child);
  return { exitCode: null, exitedBeforeTeardown: false, signal: "SIGKILL" };
}

function releaseUnsettledChild(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.channel?.unref();
  child.unref();
}
