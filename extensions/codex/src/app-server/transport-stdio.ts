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
const QA_PARENT_PID_ENV = "OPENCLAW_QA_PARENT_PID";

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
  copySafeEnvironmentEntries(env, baseEnv);
  copySafeEnvironmentEntries(env, options.env ?? {});
  const keysToClear = normalizedEnvironmentKeys(options.clearEnv ?? []);
  if (platform === "win32") {
    const lowerCaseKeysToClear = new Set(keysToClear.map((key) => key.toLowerCase()));
    for (const candidate of Object.keys(env)) {
      if (lowerCaseKeysToClear.has(candidate.toLowerCase())) {
        delete env[candidate];
      }
    }
  } else {
    for (const key of keysToClear) {
      delete env[key];
    }
  }
  for (const key of Object.keys(env)) {
    if (isCodexRuntimeInjectionEnvironmentKey(key)) {
      // Package managers and agent hosts may inject loader paths into their children. Codex does
      // not need them, so strip them before attestation and spawn instead of self-failing setup.
      delete env[key];
    }
  }
  return env;
}

function isCodexRuntimeInjectionEnvironmentKey(rawKey: string): boolean {
  const key = rawKey.toUpperCase();
  return RUNTIME_INJECTION_ENVIRONMENT_KEYS.has(key) || key.startsWith("DYLD_");
}

/** Keeps QA-owned app-server processes inside the gateway process-group cleanup boundary. */
function resolveCodexAppServerDetachedMode(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32" && !env[QA_PARENT_PID_ENV]?.trim();
}

function normalizedEnvironmentKeys(rawKeys: readonly string[]): string[] {
  const keys: string[] = [];
  for (const rawKey of rawKeys) {
    const key = rawKey.trim();
    if (key.length > 0) {
      keys.push(key);
    }
  }
  return keys;
}

function copySafeEnvironmentEntries(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_ENVIRONMENT_KEYS.has(key)) {
      continue;
    }
    target[key] = value;
  }
}

/** Spawns the Codex app-server process and returns the shared transport interface. */
export async function createStdioTransport(
  options: CodexAppServerStartOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
  assertCurrent?: () => void,
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void,
): Promise<ChildProcessWithoutNullStreams> {
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
      detached: resolveCodexAppServerDetachedMode(env),
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
