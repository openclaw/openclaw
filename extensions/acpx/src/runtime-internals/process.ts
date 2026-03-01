import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export type SpawnExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
};

type ResolvedSpawnCommand = {
  command: string;
  args: string[];
  shell?: boolean;
};

function resolvePathEnvKey(env: NodeJS.ProcessEnv): string {
  const found = Object.keys(env).find((key) => key.toLowerCase() === "path");
  return found ?? "PATH";
}

function hasPathSegment(pathValue: string, segment: string): boolean {
  if (!pathValue || !segment) {
    return false;
  }
  const expected = process.platform === "win32" ? segment.toLowerCase() : segment;
  return pathValue.split(path.delimiter).some((entryRaw) => {
    const entry = entryRaw.trim();
    if (!entry) {
      return false;
    }
    const normalized = process.platform === "win32" ? entry.toLowerCase() : entry;
    return normalized === expected;
  });
}

/**
 * Ensure PATH includes the current Node runtime directory.
 *
 * This keeps `#!/usr/bin/env node` binaries (for example plugin-local `.bin/acpx`)
 * executable even when the parent process PATH comes from a GUI/daemon context that
 * omits user-managed Node locations (nvs/nvm/fnm/asdf).
 */
export function injectNodeRuntimePath(params?: {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
}): NodeJS.ProcessEnv {
  const env = params?.env ?? process.env;
  const execPath = params?.execPath ?? process.execPath;
  const runtimeDir = path.dirname(execPath || "");
  if (!runtimeDir) {
    return env;
  }
  const pathKey = resolvePathEnvKey(env);
  const currentPath = String(env[pathKey] ?? "");
  if (hasPathSegment(currentPath, runtimeDir)) {
    return env;
  }
  const nextPath = currentPath ? `${runtimeDir}${path.delimiter}${currentPath}` : runtimeDir;
  return {
    ...env,
    [pathKey]: nextPath,
  };
}

function resolveSpawnCommand(params: { command: string; args: string[] }): ResolvedSpawnCommand {
  if (process.platform !== "win32") {
    return { command: params.command, args: params.args };
  }

  const extension = path.extname(params.command).toLowerCase();
  if (extension === ".js" || extension === ".cjs" || extension === ".mjs") {
    return {
      command: process.execPath,
      args: [params.command, ...params.args],
    };
  }

  if (extension === ".cmd" || extension === ".bat") {
    return {
      command: params.command,
      args: params.args,
      shell: true,
    };
  }

  return {
    command: params.command,
    args: params.args,
  };
}

export function spawnWithResolvedCommand(params: {
  command: string;
  args: string[];
  cwd: string;
}): ChildProcessWithoutNullStreams {
  const resolved = resolveSpawnCommand({
    command: params.command,
    args: params.args,
  });

  return spawn(resolved.command, resolved.args, {
    cwd: params.cwd,
    env: injectNodeRuntimePath(),
    stdio: ["pipe", "pipe", "pipe"],
    shell: resolved.shell,
  });
}

export async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<SpawnExit> {
  return await new Promise<SpawnExit>((resolve) => {
    let settled = false;
    const finish = (result: SpawnExit) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    child.once("error", (err) => {
      finish({ code: null, signal: null, error: err });
    });

    child.once("close", (code, signal) => {
      finish({ code, signal, error: null });
    });
  });
}

export async function spawnAndCollect(params: {
  command: string;
  args: string[];
  cwd: string;
}): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  error: Error | null;
}> {
  const child = spawnWithResolvedCommand(params);
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exit = await waitForExit(child);
  return {
    stdout,
    stderr,
    code: exit.code,
    error: exit.error,
  };
}

export function resolveSpawnFailure(
  err: unknown,
  cwd: string,
): "missing-command" | "missing-cwd" | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") {
    return null;
  }
  return directoryExists(cwd) ? "missing-command" : "missing-cwd";
}

function directoryExists(cwd: string): boolean {
  if (!cwd) {
    return false;
  }
  try {
    return existsSync(cwd);
  } catch {
    return false;
  }
}
