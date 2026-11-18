import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import { valid as validSemver } from "semver";
import {
  type CodexAppServerStartOptions,
  readCodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
  resolveCodexAppServerStartOptionsForAgent,
} from "./src/app-server/config.js";
import {
  buildCodexVersionArgs,
  isCodexAppServerProxyLaunch,
} from "./src/app-server/launch-args.js";
import {
  parseCodexVersion,
  resolveManagedCodexClientVersion,
  runCodexVersionInvocation,
} from "./src/app-server/managed-binary.js";
import { CODEX_APP_SERVER_VERSION } from "./src/app-server/version.js";

/** Custom command versions, once per process and resolution context. */
const customCodexVersions = new Map<string, string>();

/**
 * Codex client version for ChatGPT model discovery: the version of the binary
 * turns run, so listed models match what the backend accepts for them.
 * Managed starts report the selected installed Codex or the bundled pin. A
 * custom stdio command (appServer.command or OPENCLAW_CODEX_APP_SERVER_BIN)
 * reports the version of the Codex it launches; remote app-servers keep the
 * bundled pin.
 */
export async function resolveCodexClientVersion(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
}): Promise<string> {
  const { start } = resolveCodexAppServerRuntimeOptions({
    pluginConfig: readCodexPluginConfig(params.config?.plugins?.entries?.codex?.config),
    env: params.env,
  });
  if (start.transport !== "stdio") {
    return CODEX_APP_SERVER_VERSION;
  }
  if (start.commandSource === "config" || start.commandSource === "env") {
    return (
      (await resolveCustomCodexCommandVersion(start, params.env ?? process.env)) ??
      CODEX_APP_SERVER_VERSION
    );
  }
  if (start.commandSource !== "managed") {
    return CODEX_APP_SERVER_VERSION;
  }
  // Same agent-home Computer Use check that managed turns run before spawning.
  const agentStart = params.agentDir
    ? resolveCodexAppServerStartOptionsForAgent({
        startOptions: start,
        agentDir: params.agentDir,
        env: params.env,
      })
    : start;
  return resolveManagedCodexClientVersion(agentStart.managedCommandOrder ?? "package-first");
}

/**
 * The launched Codex's version for a custom command, asked through the configured
 * launcher prefix. Like the managed selection, a successful answer holds for the
 * process: app-servers that are already running keep their binary after an
 * in-place upgrade, so a later re-check would list models they cannot run. A
 * changed command, args, working directory or PATH is a new invocation and is
 * checked on its own; a failed check is not remembered. Unknown when the args
 * name no app-server subcommand, when they start an app-server proxy (the daemon
 * it joins may run another version), or when the output is not Codex's own
 * `codex-cli <version>` line (a launcher or wrapper printing its own version).
 */
async function resolveCustomCodexCommandVersion(
  start: CodexAppServerStartOptions,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const versionArgs = buildCodexVersionArgs(start.args);
  if (!versionArgs || isCodexAppServerProxyLaunch(start.args)) {
    return undefined;
  }
  let invocation: { command: string; argv: string[] };
  try {
    // Same Windows wrapper resolution the stdio transport spawns through.
    invocation = materializeWindowsSpawnProgram(
      resolveWindowsSpawnProgram({
        command: start.command,
        env,
        execPath: process.execPath,
        packageName: "@openai/codex",
      }),
      versionArgs,
    );
  } catch {
    return undefined;
  }
  const key = JSON.stringify([
    invocation.command,
    invocation.argv,
    process.cwd(),
    env.PATH ?? env.Path ?? null,
  ]);
  const known = customCodexVersions.get(key);
  if (known) {
    return known;
  }
  try {
    const output = await runCodexVersionInvocation([invocation.command, ...invocation.argv], env);
    const line = output.split("\n").find((value) => value.trimStart().startsWith("codex-cli "));
    const version = line ? validSemver(parseCodexVersion(line)) : null;
    if (version) {
      customCodexVersions.set(key, version);
      return version;
    }
  } catch {
    // Unavailable right now; the next discovery asks again.
  }
  return undefined;
}
