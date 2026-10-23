import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createWindowsOutputDecoder } from "../../infra/windows-encoding.js";
import { releaseChildProcessOutputAfterExit } from "../../process/child-process.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { waitForCommandSpawn } from "../../process/exec-spawn.js";
import { createCommandTerminationController } from "../../process/exec-termination.js";
import { spawnCommand } from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";

const DEFAULT_OUTPUT_LIMIT_CHARS = 16 * 1024 * 1024;
const FORCE_KILL_GRACE_MS = 5000;

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
  const cancelController = new AbortController();
  const startupCanceled = createDeferredCore<ExecResult>();
  let waitingForSpawn = true;
  let acceptingOutput = true;
  let killed = false;
  let terminationStarted = false;
  let timeoutId: NodeJS.Timeout | undefined;
  let terminationController: ReturnType<typeof createCommandTerminationController> | undefined;
  const killProcess = () => {
    killed = true;
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
      startupCanceled.resolve({ stdout: "", stderr: "", code: 1, killed: true });
    }
  };
  try {
    const proc = spawnCommand([command, ...args], {
      buffer: false,
      cancelSignal: cancelController.signal,
      cwd,
      detached: process.platform !== "win32",
      forceKillAfterDelay: FORCE_KILL_GRACE_MS,
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    options?.signal?.addEventListener("abort", killProcess, { once: true });
    if (options?.timeout && options.timeout > 0) {
      timeoutId = setTimeout(killProcess, options.timeout);
    }
    // Retain process cleanup after a canceled startup has returned to its caller.
    const completion = (async () => {
      if (proc.pid === undefined) {
        await waitForCommandSpawn(proc);
      }
      waitingForSpawn = false;
      const releaseOutput = releaseChildProcessOutputAfterExit(proc.nodeChildProcess);
      let childExited = false;
      proc.nodeChildProcess.once("exit", () => {
        childExited = true;
      });
      let settled = false;
      const termination = createCommandTerminationController({
        child: proc.nodeChildProcess,
        cancelController,
        processTree: { mode: "graceful" },
        killGraceMs: FORCE_KILL_GRACE_MS,
        isChildExited: () => childExited,
        isCommandSettled: () => settled,
      });
      terminationController = termination;

      const captures: Record<"stdout" | "stderr", OutputCapture> = {
        stdout: { text: "", truncatedChars: 0 },
        stderr: { text: "", truncatedChars: 0 },
      };
      const decoders = {
        stdout: createWindowsOutputDecoder({ preserveUtf8Bom: true }),
        stderr: createWindowsOutputDecoder({ preserveUtf8Bom: true }),
      };
      const maxOutputChars = clampMaxOutputChars(options?.maxOutputChars);
      const truncateOutput = options?.maxOutputChars !== undefined;
      let outputLimitExceeded: "stdout" | "stderr" | undefined;
      const captureOutput = (stream: "stdout" | "stderr", chunk: string): boolean => {
        const before = captures[stream].truncatedChars;
        captures[stream] = appendCapturedOutput(
          captures[stream],
          chunk,
          maxOutputChars,
          truncateOutput,
        );
        if (!truncateOutput && captures[stream].truncatedChars > before && !outputLimitExceeded) {
          outputLimitExceeded = stream;
          return true;
        }
        return false;
      };

      // Output pipes may fail independently; process termination remains authoritative.
      const ignoreOutputStreamError = () => {};
      for (const stream of ["stdout", "stderr"] as const) {
        proc[stream]?.on("error", ignoreOutputStreamError);
        proc[stream]?.on("data", (data) => {
          if (!acceptingOutput) {
            return;
          }
          if (captureOutput(stream, decodeCapturedOutput(decoders[stream], data))) {
            killProcess();
          }
        });
      }

      if (killed) {
        killProcess();
      }
      try {
        const code = await proc.then(
          (result) => result.exitCode ?? (result.failed ? 1 : 0),
          () => 1,
        );
        settled = true;
        clearTimeout(timeoutId);
        options?.signal?.removeEventListener("abort", killProcess);
        const cleanup = await termination.settle();
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
        const result: ExecResult = {
          stdout: captures.stdout.text,
          stderr: captures.stderr.text,
          stdoutTruncatedChars: captures.stdout.truncatedChars || undefined,
          stderrTruncatedChars: captures.stderr.truncatedChars || undefined,
          outputLimitExceeded,
          code: outputLimitExceeded ? 1 : code,
          killed,
        };
        if (cleanup === "uncertain") {
          throw new CommandProcessCleanupError({ cause: result });
        }
        return result;
      } finally {
        releaseOutput();
      }
    })();
    if (options?.signal?.aborted) {
      killProcess();
    }
    return await Promise.race([completion, startupCanceled.promise]);
  } finally {
    acceptingOutput = false;
    clearTimeout(timeoutId);
    options?.signal?.removeEventListener("abort", killProcess);
  }
}
