/** Spawns bundled LSP server processes with sanitized environment and platform handling. */
import { logWarn } from "../logger.js";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";
import { createOwnedStdioProcess, type OwnedStdioProcess } from "../process/owned-stdio.js";
import {
  collectWithheldLspEnvNames,
  formatWithheldLspEnvHints,
  LSP_ENV_PASSTHROUGH_DOCS_URL,
  resolveLspServerEnv,
} from "./agent-bundle-lsp-env.js";
import type { StdioMcpServerLaunchConfig } from "./mcp-stdio.js";

// Servers restart every turn; repeat a warning only when its server or names change.
const warnedWithheldEnv = new Set<string>();

function warnWithheldLspEnvOnce(serverName: string, childEnv: Record<string, string>): void {
  const hints = formatWithheldLspEnvHints(
    collectWithheldLspEnvNames({ parentEnv: process.env, childEnv }),
  ).join(" ");
  const key = `${serverName}\0${hints}`;
  if (!hints || warnedWithheldEnv.has(key)) {
    return;
  }
  warnedWithheldEnv.add(key);
  logWarn(
    `bundle-lsp: server "${serverName}" starts without these Gateway environment variables. ${hints} See ${LSP_ENV_PASSTHROUGH_DOCS_URL}`,
  );
}

export async function spawnLspServerProcess(
  config: StdioMcpServerLaunchConfig,
  options: { abortSignal?: AbortSignal; serverName?: string } = {},
): Promise<OwnedStdioProcess> {
  const mergedEnv = resolveLspServerEnv(config.env);
  if (options.serverName !== undefined) {
    warnWithheldLspEnvOnce(options.serverName, mergedEnv);
  }
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
