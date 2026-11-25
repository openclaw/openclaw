import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isErrno } from "../../infra/errno.js";
import { createWindowsOutputDecoder } from "../../infra/windows-encoding.js";
import { createChildProcessOutputRelease } from "../../process/child-process.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import {
  reserveCommandProcessCustody,
  resolveCommandEnv,
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
} from "../../process/exec-spawn.js";
import { createChildAdapter } from "../../process/supervisor/adapters/child.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../../process/supervisor/cancellation-policy.js";
import type {
  SpawnProcessAdapter,
  ProcessExtinctionResult,
} from "../../process/supervisor/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { getProcessInstanceStartTime } from "../../shared/pid-alive.js";
import { scheduleAbsoluteDeadline } from "../../utils/absolute-deadline.js";

const DEFAULT_OUTPUT_LIMIT_CHARS = 16 * 1024 * 1024;

export interface ExecOptions {
  /** AbortSignal to cancel the command */
  signal?: AbortSignal;
  /** Timeout in milliseconds */
  timeout?: number;
  cwd?: string;
  /** Optional maximum retained stdout/stderr characters per stream. */
  maxOutputChars?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  stdoutTruncatedChars?: number;
  stderrTruncatedChars?: number;
  outputLimitExceeded?: "stdout" | "stderr";
  code: number;
  killed: boolean;
}

type OutputCapture = {
  text: string;
  truncatedChars: number;
};
type OutputDecoder = ReturnType<typeof createWindowsOutputDecoder>;

function decodeCapturedOutput(decoder: OutputDecoder, chunk: Buffer | string): string {
  return Buffer.isBuffer(chunk) ? decoder.decode(chunk) : `${decoder.flush()}${chunk}`;
}

function clampMaxOutputChars(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_OUTPUT_LIMIT_CHARS;
  }
  return Math.max(1, Math.floor(value));
}

function appendCapturedOutput(
  current: OutputCapture,
  chunk: string,
  maxOutputChars: number,
  truncateTail: boolean,
): OutputCapture {
  const combined = `${current.text}${chunk}`;
  const overflowChars = Math.max(0, combined.length - maxOutputChars);
  const nextText =
    overflowChars === 0
      ? combined
      : truncateTail
        ? sliceUtf16Safe(combined, overflowChars)
        : sliceUtf16Safe(combined, 0, maxOutputChars);
  return {
    text: nextText,
    truncatedChars: current.truncatedChars + combined.length - nextText.length,
  };
}

export async function execCommand(
  command: string,
  args: string[],
  cwd: string,
  options?: ExecOptions,
): Promise<ExecResult> {
  const argv = [command, ...args];
  const custody = reserveCommandProcessCustody(argv);
  const inheritedSignal = resolveCommandProcessSignal();
  const signal = resolveCommandProcessSignal(options?.signal);
  const cancelController = new AbortController();
  const startupCanceled = createDeferredCore<ExecResult>();
  const cleanupDone = createDeferredCore();
  retainCommandProcessCleanup(cleanupDone.promise);
  void cleanupDone.promise.catch(() => {});
  let adapter: SpawnProcessAdapter<NodeJS.Signals | null> | undefined;
  let startupCleanup: Promise<ProcessExtinctionResult> | undefined;
  let completedResult: ExecResult | undefined;
  let waitingForSpawn = true;
  let acceptingOutput = true;
  let killed = false;
  let commandFailed = false;
  let terminationStarted = false;
  let cancelForceKill: (() => void) | undefined;
  const stopAdapter = () => {
    if (adapter && !terminationStarted) {
      terminationStarted = true;
      adapter.kill("SIGTERM");
      if (process.platform === "win32") {
        // The ordinary Windows child fallback has no native graceful-stop escalation.
        cancelForceKill = scheduleAbsoluteDeadline(
          performance.now() + GRACEFUL_CANCEL_TIMEOUT_MS,
          () => adapter?.kill("SIGKILL"),
          () => performance.now(),
        );
      }
    }
  };
  let releaseOutput: (() => void) | undefined;
  const killProcess = () => {
    if (killed) {
      return;
    }
    killed = true;
    cancelController.abort();
    stopAdapter();
    if (waitingForSpawn) {
      startupCanceled.resolve({ stdout: "", stderr: "", code: 1, killed: true });
    }
  };
  inheritedSignal?.addEventListener("abort", killProcess, { once: true });
  options?.signal?.addEventListener("abort", killProcess, { once: true });
  const cancelDeadline =
    options?.timeout && options.timeout > 0
      ? scheduleAbsoluteDeadline(performance.now() + options.timeout, killProcess, () =>
          performance.now(),
        )
      : undefined;
  const completion = (async () => {
    try {
      const startup = await createChildAdapter({
        executionIntent: "agent-tool",
        argv,
        cwd,
        env: resolveCommandEnv({ argv }),
        exactEnv: true,
        ownProcessTree: true,
        stdinMode: "pipe-closed",
        abortSignal: cancelController.signal,
        assertCurrent: () => signal?.throwIfAborted(),
        onSpawnCleanup: (cleanup) => {
          startupCleanup = cleanup;
        },
      });
      adapter = startup.adapter;
      const captures: Record<"stdout" | "stderr", OutputCapture> = {
        stdout: { text: "", truncatedChars: 0 },
        stderr: { text: "", truncatedChars: 0 },
      };
      const decoders = {
        stdout: createWindowsOutputDecoder({ preserveUtf8Bom: true }),
        stderr: createWindowsOutputDecoder({ preserveUtf8Bom: true }),
      };
      const released = createDeferredCore<{ code: number | null; signal: NodeJS.Signals | null }>();
      let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const outputRelease = createChildProcessOutputRelease(() => released.resolve(rootExit!));
      releaseOutput = outputRelease.dispose;
      adapter.onExit?.((code, exitSignal) => {
        rootExit = { code, signal: exitSignal };
        outputRelease.onExit();
      });
      const maxOutputChars = clampMaxOutputChars(options?.maxOutputChars);
      const truncateOutput = options?.maxOutputChars !== undefined;
      let outputLimitExceeded: "stdout" | "stderr" | undefined;
      const captureOutput = (stream: "stdout" | "stderr", chunk: string) => {
        outputRelease.onData();
        const before = captures[stream].truncatedChars;
        captures[stream] = appendCapturedOutput(
          captures[stream],
          chunk,
          maxOutputChars,
          truncateOutput,
        );
        if (!truncateOutput && captures[stream].truncatedChars > before && !outputLimitExceeded) {
          outputLimitExceeded = stream;
          if (!waitingForSpawn) {
            killProcess();
          }
        }
      };
      for (const stream of ["stdout", "stderr"] as const) {
        const subscribe = stream === "stdout" ? adapter.onStdout : adapter.onStderr;
        subscribe(
          (chunk) => {
            if (acceptingOutput && !adapter!.supportsRawOutput) {
              captureOutput(stream, chunk);
            }
          },
          (chunk) => {
            if (acceptingOutput) {
              captureOutput(stream, decodeCapturedOutput(decoders[stream], chunk));
            }
          },
        );
      }
      const pid = adapter.memoryRootPid ?? adapter.pid;
      if (pid !== undefined) {
        custody?.spawned({ pid, startedAt: getProcessInstanceStartTime(pid) });
      }
      await startup.ready;
      waitingForSpawn = false;
      if (outputLimitExceeded) {
        killProcess();
      }
      if (killed) {
        stopAdapter();
      }
      let exit: { code: number | null; signal: NodeJS.Signals | null };
      try {
        exit = await Promise.race([adapter.wait(), released.promise]);
      } finally {
        outputRelease.dispose();
      }
      for (const stream of ["stdout", "stderr"] as const) {
        captureOutput(stream, decoders[stream].flush());
      }
      if (outputLimitExceeded) {
        captures.stderr = appendCapturedOutput(
          captures.stderr,
          `${captures.stderr.text ? "\n" : ""}exec ${outputLimitExceeded} exceeded output limit ${maxOutputChars} chars`,
          maxOutputChars,
          true,
        );
      }
      completedResult = {
        stdout: captures.stdout.text,
        stderr: captures.stderr.text,
        stdoutTruncatedChars: captures.stdout.truncatedChars || undefined,
        stderrTruncatedChars: captures.stderr.truncatedChars || undefined,
        outputLimitExceeded,
        code: outputLimitExceeded ? 1 : (exit.code ?? 1),
        killed,
      };
      return completedResult;
    } catch (error) {
      commandFailed = true;
      stopAdapter();
      if (
        waitingForSpawn &&
        isErrno(error) &&
        /^(?:spawn|posix_spawn)(?: |$)/u.test(error.syscall ?? "")
      ) {
        return { stdout: "", stderr: "", code: 1, killed };
      }
      throw error;
    } finally {
      releaseOutput?.();
      cancelDeadline?.();
      options?.signal?.removeEventListener("abort", killProcess);
      const settle = async () => {
        try {
          const cleanup = await (adapter?.waitForExtinction?.() ?? startupCleanup);
          if (cleanup && cleanup.status === "uncertain") {
            throw new CommandProcessCleanupError({ cause: completedResult ?? cleanup });
          }
          custody?.settled();
          cleanupDone.resolve();
        } catch (error) {
          const failure = hasCommandProcessCleanupError(error)
            ? error
            : new CommandProcessCleanupError({ cause: completedResult ?? error });
          cleanupDone.reject(failure);
          throw failure;
        } finally {
          cancelForceKill?.();
          inheritedSignal?.removeEventListener("abort", killProcess);
          adapter?.dispose();
        }
      };
      const cleanup = settle();
      // A successful root may leave background work; custody follows its retained anchor.
      if (killed || commandFailed) {
        await cleanup;
      } else {
        void cleanup.catch((error: unknown) =>
          process.emitWarning(`Session exec cleanup failed: ${String(error)}`),
        );
      }
    }
  })();
  if (signal?.aborted) {
    killProcess();
  }
  try {
    return await Promise.race([completion, startupCanceled.promise]);
  } finally {
    acceptingOutput = false;
  }
}
