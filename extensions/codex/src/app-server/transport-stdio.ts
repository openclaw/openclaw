import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import { resolveLaunchableNodePath } from "openclaw/plugin-sdk/process-runtime";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
  type WindowsSpawnInvocation,
} from "openclaw/plugin-sdk/windows-spawn";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import { normalizeCodexAppServerArgs } from "./launch-args.js";
import { resolveManagedCodexNativeCommand } from "./managed-binary.js";
import { observeManagedCodexLauncherFailure } from "./managed-launcher-failure.js";
import { resolveCodexAppServerSpawnEnv } from "./spawn-env.js";
import { getCodexAppServerSpawnFailure, recordCodexAppServerSpawnFailure } from "./spawn-error.js";
import { spawnCodexStdio, type CodexStdioChild } from "./stdio-worker.js";
import { prepareCodexAppServerProcessRegistration } from "./transport-process-registration.js";
import { closeCodexAppServerTransportAndWait, type CodexAppServerTransport } from "./transport.js";

/** Resolves the concrete command/argv/shell settings used to spawn Codex app-server. */
export function resolveCodexAppServerSpawnInvocation(
  options: CodexAppServerStartOptions,
  env: NodeJS.ProcessEnv,
): WindowsSpawnInvocation {
  if (options.commandSource === "managed") {
    throw new Error("Managed Codex app-server start options must be resolved before spawn.");
  }
  const program = resolveWindowsSpawnProgram({
    command: options.command,
    platform: process.platform,
    env,
    execPath: process.execPath,
    packageName: "@openai/codex",
  });
  const args = normalizeCodexAppServerArgs(options.args);
  const resolved = materializeWindowsSpawnProgram(program, args);
  if (
    options.commandSource === "resolved-managed" &&
    resolved.resolution === "direct" &&
    [".cjs", ".js", ".mjs"].includes(path.extname(resolved.command).toLowerCase())
  ) {
    // Keep upstream's package/architecture selection and environment markers, but
    // never let its env shebang choose another Node architecture from PATH.
    return {
      ...resolved,
      command: resolveLaunchableNodePath(),
      argv: [resolved.command, ...resolved.argv],
      resolution: "node-entrypoint",
    };
  }
  return resolved;
}

/** Spawns the Codex app-server process and returns the shared transport interface. */
export async function createStdioTransport(
  options: CodexAppServerStartOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
  assertCurrent?: () => void | Promise<void>,
  onSpawn?: (child: CodexStdioChild) => void,
): Promise<CodexStdioChild> {
  const isHostedGateway = baseEnv.OPENCLAW_GATEWAY_HOST_LIFELINE?.trim() === "stdin";
  const env = resolveCodexAppServerSpawnEnv(options, baseEnv);
  const invocation = resolveCodexAppServerSpawnInvocation(options, env);
  const nativeCommand =
    options.commandSource === "resolved-managed"
      ? resolveManagedCodexNativeCommand(options.command, { pathExists: () => true })
      : undefined;
  const launchKey = JSON.stringify([
    invocation.command,
    options.cwd ?? process.cwd(),
    nativeCommand ?? null,
    path.isAbsolute(invocation.command) ? null : (env.PATH ?? env.Path),
  ]);
  const previousFailure =
    getCodexAppServerSpawnFailure(launchKey) ??
    (nativeCommand ? getCodexAppServerSpawnFailure(nativeCommand) : undefined);
  if (previousFailure) {
    throw previousFailure;
  }
  const register = await prepareCodexAppServerProcessRegistration();
  await assertCurrent?.();
  embeddedAgentLog.debug("Codex app-server spawn", {
    command: invocation.command,
    launcher: options.command,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(nativeCommand ? { nativeCommand } : {}),
    platform: process.platform,
    arch: process.arch,
  });
  let child: CodexStdioChild & Pick<CodexAppServerTransport, "startupFailure">;
  try {
    child = spawnCodexStdio(
      invocation.command,
      invocation.argv,
      {
        // Preserve the shipped Supervisor endpoint contract: relative commands and
        // config discovery may depend on the endpoint's process working directory.
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env,
        // Child environment overrides cannot change the Gateway's containment boundary.
        detached: process.platform !== "win32" && !isHostedGateway,
        shell: invocation.shell,
        windowsHide: invocation.windowsHide,
      },
      assertCurrent,
    );
  } catch (error) {
    throw recordCodexAppServerSpawnFailure(error, invocation.command, launchKey);
  }
  try {
    if (nativeCommand && invocation.resolution === "node-entrypoint") {
      observeManagedCodexLauncherFailure(child, nativeCommand);
    }
    // Attach lifecycle observers before inspection can yield to an early exit.
    onSpawn?.(child);
    await register(child);
    await assertCurrent?.();
    return child;
  } catch (error) {
    await closeCodexAppServerTransportAndWait(child, { drainStdio: true });
    await assertCurrent?.();
    throw (
      child.startupFailure?.error ??
      recordCodexAppServerSpawnFailure(error, invocation.command, launchKey)
    );
  }
}
