import { spawn as startOpenClawCliProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export type MatrixQaCliRunResult = {
  args: string[];
  exitCode: number;
  stderr: string;
  stdout: string;
};

export type MatrixQaCliSession = {
  args: string[];
  output: () => { stderr: string; stdout: string };
  wait: () => Promise<MatrixQaCliRunResult>;
  waitForOutput: (
    predicate: (output: { stderr: string; stdout: string; text: string }) => boolean,
    label: string,
    timeoutMs: number,
  ) => Promise<{ stderr: string; stdout: string; text: string }>;
  writeStdin: (text: string) => Promise<void>;
  kill: () => void;
};

function formatMatrixQaCliCommand(args: string[]) {
  return `openclaw ${args.join(" ")}`;
}

function buildMatrixQaCliResult(params: {
  args: string[];
  exitCode: number;
  output: { stderr: string; stdout: string };
}): MatrixQaCliRunResult {
  return {
    args: params.args,
    exitCode: params.exitCode,
    stderr: params.output.stderr,
    stdout: params.output.stdout,
  };
}

function formatMatrixQaCliExitError(result: MatrixQaCliRunResult) {
  return [
    `${formatMatrixQaCliCommand(result.args)} exited ${result.exitCode}`,
    result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : null,
    result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function startMatrixQaOpenClawCli(params: {
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): MatrixQaCliSession {
  const cwd = params.cwd ?? process.cwd();
  const distEntryPath = path.join(cwd, "dist", "index.js");
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let closed = false;
  let closeResult: MatrixQaCliRunResult | undefined;
  let settleWait:
    | {
        reject: (error: Error) => void;
        resolve: (result: MatrixQaCliRunResult) => void;
      }
    | undefined;

  const child = startOpenClawCliProcess(process.execPath, [distEntryPath, ...params.args], {
    cwd,
    env: params.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const readOutput = () => ({
    stderr: Buffer.concat(stderr).toString("utf8"),
    stdout: Buffer.concat(stdout).toString("utf8"),
  });
  const finish = (result: MatrixQaCliRunResult, error?: Error) => {
    if (closed) {
      return;
    }
    closed = true;
    closeResult = result;
    if (!settleWait) {
      return;
    }
    if (error) {
      settleWait.reject(error);
    } else {
      settleWait.resolve(result);
    }
  };

  const timeout = setTimeout(() => {
    const result = buildMatrixQaCliResult({
      args: params.args,
      exitCode: 1,
      output: readOutput(),
    });
    child.kill("SIGTERM");
    finish(
      result,
      new Error(`${formatMatrixQaCliCommand(params.args)} timed out after ${params.timeoutMs}ms`),
    );
  }, params.timeoutMs);

  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  child.on("error", (error) => {
    clearTimeout(timeout);
    finish(
      buildMatrixQaCliResult({
        args: params.args,
        exitCode: 1,
        output: readOutput(),
      }),
      error,
    );
  });
  child.on("close", (exitCode) => {
    clearTimeout(timeout);
    const result = buildMatrixQaCliResult({
      args: params.args,
      exitCode: exitCode ?? 1,
      output: readOutput(),
    });
    if (result.exitCode !== 0) {
      finish(result, new Error(formatMatrixQaCliExitError(result)));
      return;
    }
    finish(result);
  });

  return {
    args: params.args,
    output: readOutput,
    wait: async () =>
      await new Promise<MatrixQaCliRunResult>((resolve, reject) => {
        if (closed && closeResult) {
          if (closeResult.exitCode === 0) {
            resolve(closeResult);
          } else {
            reject(new Error(formatMatrixQaCliExitError(closeResult)));
          }
          return;
        }
        settleWait = { reject, resolve };
      }).catch((error) => {
        throw new Error(
          `Matrix QA CLI command failed (${params.args.join(" ")}): ${formatErrorMessage(error)}`,
        );
      }),
    waitForOutput: async (predicate, label, timeoutMs) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const output = readOutput();
        const text = `${output.stdout}\n${output.stderr}`;
        if (predicate({ ...output, text })) {
          return { ...output, text };
        }
        if (closed) {
          break;
        }
        await sleep(Math.min(100, Math.max(25, timeoutMs - (Date.now() - startedAt))));
      }
      const output = readOutput();
      throw new Error(
        `openclaw ${params.args.join(" ")} did not print ${label} before timeout\nstdout:\n${output.stdout.trim()}\nstderr:\n${output.stderr.trim()}`,
      );
    },
    writeStdin: async (text) => {
      if (!child.stdin.write(text)) {
        await new Promise<void>((resolve) => child.stdin.once("drain", resolve));
      }
    },
    kill: () => {
      if (!closed) {
        child.kill("SIGTERM");
      }
    },
  };
}

export async function runMatrixQaOpenClawCli(params: {
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<MatrixQaCliRunResult> {
  return await startMatrixQaOpenClawCli(params).wait();
}
