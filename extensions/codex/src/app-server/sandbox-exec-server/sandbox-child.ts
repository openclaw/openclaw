/** Owns one sandbox subprocess tree through close, reaping, and backend finalization. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  signalProcessTree,
  spawnTerminalPty,
  type TerminalPtyHandle,
} from "openclaw/plugin-sdk/process-runtime";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";

const SANDBOX_CHILD_TERM_GRACE_MS = 1_000;
// Covers the post-TERM tree kill plus Windows taskkill completion before failure is reported.
const SANDBOX_CHILD_REAP_TIMEOUT_MS = 4_500;
const SANDBOX_CHILD_INTERRUPT_POLL_MS = 50;

type SandboxChildOutcome = { exitCode: number; signal: NodeJS.Signals | number | null };

export type SandboxChildOwner = {
  /** Retained input uses the same captured authority as process admission. */
  assertCurrent: () => void;
  exited: Promise<SandboxChildOutcome>;
  closed: Promise<SandboxChildOutcome>;
  settled: Promise<SandboxChildOutcome>;
  terminate: () => Promise<SandboxChildOutcome>;
};

export type SandboxPipeChildOwner = SandboxChildOwner & {
  process: ChildProcessWithoutNullStreams;
  interrupt: () => Promise<void>;
};

type SandboxPtyChildOwner = SandboxChildOwner & {
  pty: TerminalPtyHandle;
  interrupt: () => Promise<void>;
};

export type SandboxChild = SandboxPipeChildOwner | SandboxPtyChildOwner;

type SandboxChildStartParams = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  usePty?: boolean;
  assertCurrent?: () => void;
  finalizeExec?: NonNullable<SandboxContext["backend"]>["finalizeExec"];
  finalizeToken?: unknown;
  finalizeStatus: (outcome: SandboxChildOutcome) => "completed" | "failed";
  onFinalizeError: (error: unknown) => void;
  owners: Set<SandboxChildOwner>;
  terminateRemote?: () => Promise<void>;
  interruptRemote?: (timeoutMs: number) => Promise<boolean>;
};

export function spawnSandboxChild(
  params: SandboxChildStartParams & { usePty?: false },
): Promise<SandboxPipeChildOwner>;
export function spawnSandboxChild(params: SandboxChildStartParams): Promise<SandboxChild>;
export async function spawnSandboxChild(params: SandboxChildStartParams): Promise<SandboxChild> {
  const [command, ...args] = params.argv;
  const finalize = async (status: "completed" | "failed", exitCode: number | null) =>
    await params.finalizeExec?.({
      status,
      exitCode,
      timedOut: false,
      token: params.finalizeToken,
    });
  if (!command) {
    await finalize("failed", null).catch(params.onFinalizeError);
    throw new Error("OpenClaw sandbox exec spec did not provide a command.");
  }
  let child: ChildProcessWithoutNullStreams | undefined;
  let pty: TerminalPtyHandle | undefined;
  let exitOutcome: SandboxChildOutcome | undefined;
  let outcome: SandboxChildOutcome | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const ready = createDeferred<void>();
  const exited = createDeferred<SandboxChildOutcome>();
  const closed = createDeferred<SandboxChildOutcome>();
  const recordExit = (exitCode: number, signal: SandboxChildOutcome["signal"]) => {
    if (!exitOutcome) {
      clearTimeout(escalation);
      exited.resolve((exitOutcome = { exitCode, signal }));
    }
  };
  const recordClose = (exitCode: number, signal: SandboxChildOutcome["signal"]) => {
    recordExit(exitCode, signal);
    closed.resolve((outcome = { exitCode, signal }));
  };
  let startFailed = false;
  let startupPending = true;
  let terminationRequested = false;
  let terminationCleanup: Promise<void> | undefined;
  let terminationError: Error | undefined;
  let settlementStarted = false;
  const interruptions = new Set<Promise<void>>();
  const localSignals: Promise<void>[] = [];
  const settled = closed.promise.then(async (result) => {
    settlementStarted = true;
    await terminationCleanup;
    if (interruptions.size > 0) {
      await Promise.allSettled(interruptions);
    }
    await Promise.all(localSignals);
    child?.stdin?.destroy();
    await finalize(
      startFailed ? "failed" : params.finalizeStatus(result),
      startFailed ? null : result.exitCode,
    );
    return result;
  });
  void settled.catch(params.onFinalizeError);

  const assertCurrent = () => {
    params.assertCurrent?.();
    if (terminationRequested) {
      throw new Error("Sandbox child process start cancelled");
    }
  };
  let terminationPromise: Promise<SandboxChildOutcome> | undefined;
  const owner: SandboxChildOwner = {
    assertCurrent,
    exited: exited.promise,
    closed: closed.promise,
    settled,
    terminate: () =>
      (terminationPromise ??= (async () => {
        terminationRequested = true;
        if (startupPending) {
          await ready.promise;
        }
        if (startFailed || settlementStarted) {
          return await settled;
        }
        child?.stdin?.destroy();
        terminationCleanup = params.terminateRemote?.().catch((error: unknown) => {
          terminationError = error instanceof Error ? error : new Error(String(error));
        });
        await terminationCleanup;
        if (!outcome) {
          const signalLocal = (signal: "SIGTERM" | "SIGKILL") => {
            if (exitOutcome) {
              return;
            }
            if (pty) {
              pty.kill(signal);
            } else if (child?.pid) {
              const pid = child.pid;
              localSignals.push(
                new Promise<void>((resolve) => {
                  signalProcessTree(pid, signal, {
                    detached: process.platform !== "win32",
                    onComplete: resolve,
                  });
                }),
              );
            } else {
              child?.kill(signal);
            }
          };
          signalLocal("SIGTERM");
          if (!exitOutcome) {
            escalation = setTimeout(() => signalLocal("SIGKILL"), SANDBOX_CHILD_TERM_GRACE_MS);
            escalation.unref?.();
          }
          const reaped = await Promise.race([
            closed.promise.then(() => true),
            delay(SANDBOX_CHILD_REAP_TIMEOUT_MS).then(() => false),
          ]).finally(() => clearTimeout(escalation));
          await Promise.all(localSignals);
          if (!reaped) {
            throw new Error(
              `Sandbox child process tree ${pty?.pid ?? child?.pid ?? "unknown"} survived SIGKILL; tear down the sandbox environment and inspect the surviving process tree before retrying.`,
            );
          }
        }
        const result = await settled;
        if (terminationError) {
          throw terminationError;
        }
        return result;
      })()),
  };
  params.owners.add(owner);
  void settled.then(
    () => params.owners.delete(owner),
    () => params.owners.delete(owner),
  );
  const interrupt = async () => {
    await ready.promise;
    const interruptRemote = params.interruptRemote;
    if (exitOutcome || terminationRequested || !interruptRemote) {
      return;
    }
    const interruption = (async () => {
      const deadline = performance.now() + SANDBOX_CHILD_REAP_TIMEOUT_MS;
      // The local transport can be ready before the marked process exists on its target.
      while (true) {
        if (exitOutcome || terminationRequested) {
          return;
        }
        const remainingMs = Math.ceil(deadline - performance.now());
        if (remainingMs <= 0) {
          throw new Error(
            "Sandbox process interrupt timed out waiting for remote process admission",
          );
        }
        if (await interruptRemote(remainingMs)) {
          return;
        }
        await Promise.race([
          delay(
            Math.min(SANDBOX_CHILD_INTERRUPT_POLL_MS, Math.max(0, deadline - performance.now())),
          ),
          exited.promise,
        ]);
      }
    })();
    interruptions.add(interruption);
    try {
      await interruption;
    } finally {
      interruptions.delete(interruption);
    }
  };
  try {
    if (params.usePty) {
      const env = Object.fromEntries(
        Object.entries(params.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      pty = await spawnTerminalPty(
        { file: command, args, cwd: params.cwd, env, cols: 80, rows: 24 },
        { assertCurrent },
      );
      pty.onExit(({ exitCode, signal }) => {
        // node-pty leaves exitCode at zero on a signal; native PTY execution reports failure.
        recordClose(signal ? 1 : exitCode, signal || null);
      });
      return { ...owner, pty, interrupt };
    }
    assertCurrent();
    child = spawn(command, args, {
      detached: process.platform !== "win32",
      env: params.env,
      cwd: params.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.once("exit", (code, signal) => recordExit(code ?? 1, signal));
    child.once("close", (code, signal) => recordClose(code ?? 1, signal));
    const markStartFailed = () => {
      startFailed = true;
    };
    child.once("error", markStartFailed);
    try {
      await once(child, "spawn");
    } finally {
      child.off("error", markStartFailed);
    }
    return { ...owner, process: child, interrupt };
  } catch (error) {
    startFailed = true;
    if (!child) {
      recordClose(1, null);
    }
    await settled.catch(() => undefined);
    throw error;
  } finally {
    startupPending = false;
    ready.resolve();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
