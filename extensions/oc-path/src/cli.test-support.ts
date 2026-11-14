import { Command, CommanderError } from "commander";
import { vi } from "vitest";
import { registerPathCli } from "./cli.js";

type PathCommandOptions = {
  readonly json?: boolean;
  readonly human?: boolean;
  readonly valueJson?: boolean;
  readonly cwd?: string;
  readonly file?: string;
  readonly dryRun?: boolean;
  readonly diff?: boolean;
};

export interface TestRuntime {
  readonly stdout: string[];
  readonly stderr: string[];
  exitCode: number;
}

export function createTestRuntime(): TestRuntime {
  return { stdout: [], stderr: [], exitCode: 0 };
}

export const stdoutText = (rt: TestRuntime): string => rt.stdout.join("");
export const stderrText = (rt: TestRuntime): string => rt.stderr.join("");

function commandArgs(options: PathCommandOptions, ...args: (string | undefined)[]): string[] {
  return [
    ...args.filter((arg): arg is string => arg !== undefined),
    ...Object.entries({
      "--json": options.json,
      "--human": options.human,
      "--value-json": options.valueJson,
      "--cwd": options.cwd,
      "--file": options.file,
      "--dry-run": options.dryRun,
      "--diff": options.diff,
    }).flatMap(([flag, value]) =>
      value === true ? [flag] : typeof value === "string" ? [flag, value] : [],
    ),
  ];
}

function captureOutput(stream: NodeJS.WriteStream, chunks: string[]) {
  return vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof stream.write);
}

async function invokePathCli(args: string[], runtime: TestRuntime): Promise<void> {
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  const stdoutWrite = captureOutput(process.stdout, runtime.stdout);
  const stderrWrite = captureOutput(process.stderr, runtime.stderr);
  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: (value) => runtime.stdout.push(value),
      writeErr: (value) => runtime.stderr.push(value),
    });
    registerPathCli(program);
    await program.parseAsync(["node", "openclaw", "path", ...args]);
    runtime.exitCode = process.exitCode ?? 0;
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error;
    }
    runtime.exitCode = error.exitCode;
  } finally {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    // Bun cannot clear a nonzero exit code with undefined, so restore an unset code as zero.
    process.exitCode = previousExitCode ?? 0;
  }
}

function unaryCommand(command: string) {
  return (path: string | undefined, options: PathCommandOptions, runtime: TestRuntime) =>
    invokePathCli(commandArgs(options, command, path), runtime);
}

export const pathResolveCommand = unaryCommand("resolve");
export const pathFindCommand = unaryCommand("find");
export const pathValidateCommand = unaryCommand("validate");
export const pathEmitCommand = unaryCommand("emit");

export const pathSetCommand = (
  path: string | undefined,
  value: string | undefined,
  options: PathCommandOptions,
  runtime: TestRuntime,
): Promise<void> => invokePathCli(commandArgs(options, "set", path, value), runtime);
