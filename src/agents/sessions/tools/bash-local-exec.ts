import { existsSync } from "node:fs";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { toErrorObject } from "../../../infra/errors.js";
import { releaseChildProcessOutputAfterExit } from "../../../process/child-process.js";
import {
  COMMAND_PROCESS_TREE_KILL_GRACE_MS,
  waitForCommandSpawn,
} from "../../../process/exec-spawn.js";
import { createCommandTerminationController } from "../../../process/exec-termination.js";
import { spawnCommand } from "../../../process/exec.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  buildShellCommandInvocation,
  getBashShellConfig,
  getBashShellEnv,
} from "../../shell-utils.js";
import type { BashOperations } from "./bash-operations.js";

export function resolveBashTimeoutMs(timeoutSeconds: unknown): number | undefined {
  if (timeoutSeconds === undefined) {
    return undefined;
  }
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    throw new Error("Invalid timeout: must be a positive finite number of seconds");
  }
  return resolveTimerTimeoutMs(timeoutSeconds * 1000, 1);
}

/** Local shell execution owns cancellation from admission through final output cleanup. */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const timeoutMs = resolveBashTimeoutMs(timeout);
      const shellConfig = getBashShellConfig(options?.shellPath);
      const invocation = buildShellCommandInvocation(command, shellConfig);
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      const shellEnv = env ?? getBashShellEnv(shellConfig.shell);
      const cancelController = new AbortController();
      const startupCanceled = createDeferredCore<never>();
      void startupCanceled.promise.catch(() => {});
      let waitingForSpawn = true;
      let acceptingOutput = true;
      let cancellationRequested = false;
      let terminationStarted = false;
      let timedOut = false;
      let terminationController: ReturnType<typeof createCommandTerminationController> | undefined;
      const terminate = () => {
        cancellationRequested = true;
        if (terminationController) {
          if (!terminationStarted) {
            terminationStarted = true;
            if (!terminationController.terminate()) {
              cancelController.abort();
            }
          }
        } else {
          cancelController.abort();
        }
        if (waitingForSpawn) {
          startupCanceled.reject(new Error(signal?.aborted ? "aborted" : `timeout:${timeout}`));
        }
      };
      signal?.addEventListener("abort", terminate, { once: true });
      const timeoutHandle =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              terminate();
            }, timeoutMs);
      try {
        const child = spawnCommand(invocation.argv, {
          baseEnv: {},
          buffer: false,
          cancelSignal: cancelController.signal,
          cwd,
          detached: process.platform !== "win32",
          env: shellEnv,
          forceKillAfterDelay: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
          ...(invocation.input === undefined ? {} : { input: invocation.input }),
          reject: false,
          stdio: [invocation.stdin, "pipe", "pipe"],
        });
        // This continuation retains late PID cleanup even when startup cancellation
        // returns to the caller before the broker finishes its handshake.
        const completion = (async () => {
          if (child.pid === undefined) {
            await waitForCommandSpawn(child);
          }
          waitingForSpawn = false;
          const releaseOutput = releaseChildProcessOutputAfterExit(child.nodeChildProcess);
          let childExited = false;
          child.nodeChildProcess.once("exit", () => {
            childExited = true;
          });
          let commandSettled = false;
          const termination = createCommandTerminationController({
            child: child.nodeChildProcess,
            cancelController,
            baseEnv: {},
            env: shellEnv,
            processTree: { mode: "force" },
            killGraceMs: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
            isChildExited: () => childExited,
            isCommandSettled: () => commandSettled,
          });
          terminationController = termination;
          child.stdout?.on("data", (data: Buffer) => {
            if (acceptingOutput) {
              onData(data, "stdout");
            }
          });
          child.stderr?.on("data", (data: Buffer) => {
            if (acceptingOutput) {
              onData(data, "stderr");
            }
          });
          if (cancellationRequested) {
            terminate();
          }
          let result: Awaited<typeof child>;
          try {
            result = await child;
          } finally {
            commandSettled = true;
            try {
              await termination.settle();
            } finally {
              releaseOutput();
            }
          }
          if (result.failed && result.exitCode === undefined && result.signal === undefined) {
            if (result instanceof Error) {
              throw result;
            }
            throw new Error(`Failed to launch shell: ${shellConfig.shell}`, { cause: result });
          }
          if (signal?.aborted) {
            throw new Error("aborted");
          }
          if (timedOut || result.timedOut) {
            throw new Error(`timeout:${timeout}`);
          }
          return { exitCode: result.exitCode ?? (result.failed ? 1 : 0) };
        })();
        return await Promise.race([completion, startupCanceled.promise]);
      } catch (error) {
        throw toErrorObject(error, "Non-Error rejection");
      } finally {
        acceptingOutput = false;
        clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", terminate);
      }
    },
  };
}
