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
  return {
    stdout: [],
    stderr: [],
    exitCode: 0,
  };
}

export const stdoutText = (rt: TestRuntime): string => rt.stdout.join("");
export const stderrText = (rt: TestRuntime): string => rt.stderr.join("");

function optionArgs(options: PathCommandOptions): string[] {
  const args: string[] = [];
  if (options.json === true) {
    args.push("--json");
  }
  if (options.human === true) {
    args.push("--human");
  }
  if (options.valueJson === true) {
    args.push("--value-json");
  }
  if (options.cwd !== undefined) {
    args.push("--cwd", options.cwd);
  }
  if (options.file !== undefined) {
    args.push("--file", options.file);
  }
  if (options.dryRun === true) {
    args.push("--dry-run");
  }
  if (options.diff === true) {
    args.push("--diff");
  }
  return args;
}

async function invokePathCli(args: string[], runtime: TestRuntime): Promise<void> {
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    runtime.stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    runtime.stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
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
  return async (path: string | undefined, options: PathCommandOptions, runtime: TestRuntime) => {
    await invokePathCli(
      [command, ...(path === undefined ? [] : [path]), ...optionArgs(options)],
      runtime,
    );
  };
}

export const pathResolveCommand = unaryCommand("resolve");
export const pathFindCommand = unaryCommand("find");
export const pathValidateCommand = unaryCommand("validate");
export const pathEmitCommand = unaryCommand("emit");

export async function pathSetCommand(
  path: string | undefined,
  value: string | undefined,
  options: PathCommandOptions,
  runtime: TestRuntime,
): Promise<void> {
  await invokePathCli(
    [
      "set",
      ...(path === undefined ? [] : [path]),
      ...(value === undefined ? [] : [value]),
      ...optionArgs(options),
    ],
    runtime,
  );
}
