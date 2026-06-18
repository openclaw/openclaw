import { spawn } from "node:child_process";

export type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (command, args, options = {}) =>
  await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`command timed out: ${command} ${args.join(" ")}`));
        }, options.timeoutMs)
      : undefined;
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errorChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({
        code: code ?? 1,
        stderr: Buffer.concat(errorChunks).toString("utf8"),
        stdout: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
