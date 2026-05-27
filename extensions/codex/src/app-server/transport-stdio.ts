import { spawn } from "node:child_process";
import fs from "node:fs";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import type { CodexAppServerStartOptions } from "./config.js";
import type { CodexAppServerTransport } from "./transport.js";

const UNSAFE_ENVIRONMENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SYSTEMD_RUN = "/usr/bin/systemd-run";
const SYSTEMD_SCOPE_DISABLE_ENV = "OPENCLAW_CHILD_SYSTEMD_SCOPE";
const SYSTEMD_WORKER_SLICE = "openclaw-workers.slice";

type CodexAppServerSpawnRuntime = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
};

const DEFAULT_SPAWN_RUNTIME: CodexAppServerSpawnRuntime = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
};

export function resolveCodexAppServerSpawnInvocation(
  options: CodexAppServerStartOptions,
  runtime: CodexAppServerSpawnRuntime = DEFAULT_SPAWN_RUNTIME,
): { command: string; args: string[]; shell?: boolean; windowsHide?: boolean } {
  if (options.commandSource === "managed") {
    throw new Error("Managed Codex app-server start options must be resolved before spawn.");
  }
  const program = resolveWindowsSpawnProgram({
    command: options.command,
    platform: runtime.platform,
    env: runtime.env,
    execPath: runtime.execPath,
    packageName: "@openai/codex",
  });
  const resolved = materializeWindowsSpawnProgram(program, options.args);
  return {
    command: resolved.command,
    args: resolved.argv,
    shell: resolved.shell,
    windowsHide: resolved.windowsHide,
  };
}

export function resolveCodexAppServerWorkerScopeSpawn(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  systemdRunPath?: string;
  systemdRunExists?: (path: string) => boolean;
}): { command: string; args: string[]; env: NodeJS.ProcessEnv; wrapped: boolean } {
  const platform = params.platform ?? process.platform;
  const systemdRunPath = params.systemdRunPath ?? SYSTEMD_RUN;
  const systemdRunExists = params.systemdRunExists ?? ((candidate) => fs.existsSync(candidate));
  if (
    platform !== "linux" ||
    !params.env.OPENCLAW_SERVICE_MARKER?.trim() ||
    systemdScopeDisabled(params.env) ||
    !systemdRunExists(systemdRunPath)
  ) {
    return { command: params.command, args: params.args, env: params.env, wrapped: false };
  }
  return {
    command: systemdRunPath,
    args: [
      "--user",
      "--scope",
      "--quiet",
      `--property=Slice=${SYSTEMD_WORKER_SLICE}`,
      "--property=CollectMode=inactive-or-failed",
      "--",
      params.command,
      ...params.args,
    ],
    env: {
      ...params.env,
      // The app-server scope owns its MCP/tool subprocesses. Avoid recursive
      // transient scopes when worker-side OpenClaw code launches children.
      [SYSTEMD_SCOPE_DISABLE_ENV]: "0",
    },
    wrapped: true,
  };
}

function systemdScopeDisabled(env: NodeJS.ProcessEnv): boolean {
  switch (env[SYSTEMD_SCOPE_DISABLE_ENV]?.trim().toLowerCase()) {
    case "0":
    case "false":
    case "no":
    case "off":
      return true;
    default:
      return false;
  }
}

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
  return env;
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

export function createStdioTransport(options: CodexAppServerStartOptions): CodexAppServerTransport {
  const env = resolveCodexAppServerSpawnEnv(options);
  const invocation = resolveCodexAppServerSpawnInvocation(options, {
    platform: process.platform,
    env,
    execPath: process.execPath,
  });
  const scopedInvocation = resolveCodexAppServerWorkerScopeSpawn({
    command: invocation.command,
    args: invocation.args,
    env,
    platform: process.platform,
  });
  return spawn(scopedInvocation.command, scopedInvocation.args, {
    env: scopedInvocation.env,
    detached: process.platform !== "win32" && !scopedInvocation.wrapped,
    shell: invocation.shell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: invocation.windowsHide,
  });
}
