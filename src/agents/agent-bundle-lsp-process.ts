/** Spawns bundled LSP server processes with sanitized environment and platform handling. */
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";
import { createOwnedStdioProcess, type OwnedStdioProcess } from "../process/owned-stdio.js";
import type { StdioMcpServerLaunchConfig } from "./mcp-stdio.js";

export async function spawnLspServerProcess(
  config: StdioMcpServerLaunchConfig,
  options: { abortSignal?: AbortSignal } = {},
): Promise<OwnedStdioProcess> {
  const mergedEnv = sanitizeHostExecEnv({
    baseEnv: process.env,
    overrides: config.env ?? null,
  });
  const program = resolveWindowsSpawnProgram({
    command: config.command,
    env: mergedEnv,
    allowShellFallback: true,
  });
  const invocation = materializeWindowsSpawnProgram(program, config.args ?? []);
  return await createOwnedStdioProcess({
    argv: [invocation.command, ...invocation.argv],
    env: mergedEnv,
    exactEnv: true,
    cwd: config.cwd,
    abortSignal: options.abortSignal,
    // Stable LSP config permits unresolved Windows wrappers to use Node's shell parsing.
    ...(invocation.shell === true ? { windowsShell: true } : {}),
  });
}
