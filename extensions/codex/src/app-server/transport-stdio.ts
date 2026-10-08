/**
 * Creates and configures stdio-backed Codex app-server transports, including
 * Windows spawn normalization and environment filtering.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
  type WindowsSpawnInvocation,
} from "openclaw/plugin-sdk/windows-spawn";
import type { CodexAppServerStartOptions } from "./config.js";
import { normalizeCodexAppServerArgs } from "./launch-args.js";
import { resolveManagedCodexNativeCommand } from "./managed-binary.js";
import { observeManagedCodexLauncherFailure } from "./managed-launcher-failure.js";
import { getCodexAppServerSpawnFailure, recordCodexAppServerSpawnFailure } from "./spawn-error.js";
import { prepareCodexAppServerProcessRegistration } from "./transport-process-registration.js";
import { closeCodexAppServerTransportAndWait, type CodexAppServerTransport } from "./transport.js";

const UNSAFE_ENVIRONMENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RUNTIME_INJECTION_ENVIRONMENT_KEYS = new Set([
  "NODE_PATH",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
]);

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
      command: process.execPath,
      argv: [resolved.command, ...resolved.argv],
      resolution: "node-entrypoint",
    };
  }
  return resolved;
}

/** Merges app-server environment overrides while honoring clearEnv and unsafe key filtering. */
export function resolveCodexAppServerSpawnEnv(
  options: Pick<CodexAppServerStartOptions, "env" | "clearEnv">,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = Object.create(null) as NodeJS.ProcessEnv;
  for (const source of [baseEnv, options.env ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      if (!UNSAFE_ENVIRONMENT_KEYS.has(key)) {
        env[key] = value;
      }
    }
  }
  const normalizeKey = (key: string) => (platform === "win32" ? key.toLowerCase() : key);
  const keysToClear = new Set(
    (options.clearEnv ?? []).map((key) => normalizeKey(key.trim())).filter(Boolean),
  );
  for (const key of Object.keys(env)) {
    const upperKey = key.toUpperCase();
    const runtimeInjection =
      RUNTIME_INJECTION_ENVIRONMENT_KEYS.has(upperKey) || upperKey.startsWith("DYLD_");
    if (keysToClear.has(normalizeKey(key)) || runtimeInjection) {
      // Package managers and agent hosts may inject loader paths into their children. Codex does
      // not need them, so strip them before attestation and spawn instead of self-failing setup.
      delete env[key];
    }
  }
  return env;
}

/** Spawns the Codex app-server process and returns the shared transport interface. */
export async function createStdioTransport(
  options: CodexAppServerStartOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
  assertCurrent?: () => void,
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void,
): Promise<ChildProcessWithoutNullStreams> {
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
  assertCurrent?.();
  embeddedAgentLog.debug("Codex app-server spawn", {
    command: invocation.command,
    launcher: options.command,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(nativeCommand ? { nativeCommand } : {}),
    platform: process.platform,
    arch: process.arch,
  });
  let child: ChildProcessWithoutNullStreams & Pick<CodexAppServerTransport, "startupFailure">;
  try {
    child = spawn(invocation.command, invocation.argv, {
      // Preserve the shipped Supervisor endpoint contract: relative commands and
      // config discovery may depend on the endpoint's process working directory.
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env,
      // Child environment overrides cannot change the Gateway's containment boundary.
      detached: process.platform !== "win32" && !isHostedGateway,
      shell: invocation.shell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: invocation.windowsHide,
    });
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
    assertCurrent?.();
    return child;
  } catch (error) {
    await closeCodexAppServerTransportAndWait(child, { drainStdio: true });
    assertCurrent?.();
    throw (
      child.startupFailure?.error ??
      recordCodexAppServerSpawnFailure(error, invocation.command, launchKey)
    );
  }
}
