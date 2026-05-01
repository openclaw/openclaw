import { spawn } from "node:child_process";

export type CommandRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /** Stdin payload, if any. */
    input?: string;
  },
) => Promise<CommandRunResult>;

/**
 * Default Node child_process-based runner. Used in production by the Stripe Link adapter.
 * Tests inject their own runner.
 */
export function createNodeCommandRunner(): CommandRunner {
  return function runCommand(
    command: string,
    args: readonly string[],
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      input?: string;
    },
  ): Promise<CommandRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options?.cwd,
        env: options?.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs);
      }

      child.on("error", (err: Error) => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        reject(new Error(`Command "${command}" failed to spawn: ${err.message}`));
      });

      child.on("close", (code: number | null) => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        if (timedOut) {
          reject(
            new Error(
              `Command "${command}" timed out after ${options?.timeoutMs ?? 0}ms and was killed with SIGTERM`,
            ),
          );
          return;
        }
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          exitCode: code ?? 1,
        });
      });

      // Write stdin if provided
      if (options?.input !== undefined) {
        child.stdin.write(options.input, "utf8", () => {
          child.stdin.end();
        });
      } else {
        child.stdin.end();
      }
    });
  };
}
