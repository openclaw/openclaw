import { homedir } from "node:os";
import path from "node:path";
import { runCommandWithTimeout, type CommandOptions } from "openclaw/plugin-sdk/process-runtime";

export function runCrabboxProcess(argv: string[], options: CommandOptions) {
  // Resolve configured executable paths before leaving the caller's directory.
  const command =
    options.cwd === undefined && argv[0] && /[\\/]/u.test(argv[0])
      ? [path.resolve(argv[0]), ...argv.slice(1)]
      : argv;
  return runCommandWithTimeout(command, { ...options, cwd: options.cwd ?? homedir() });
}
