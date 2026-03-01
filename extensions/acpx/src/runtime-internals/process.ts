import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
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
  windowsHide?: boolean;
};

type SpawnRuntime = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
};

const DEFAULT_RUNTIME: SpawnRuntime = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
};

function isFilePath(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveWindowsExecutablePath(command: string, env: NodeJS.ProcessEnv): string {
  if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) {
    return command;
  }

  const pathValue = env.PATH ?? env.Path ?? process.env.PATH ?? process.env.Path ?? "";
  const pathEntries = pathValue
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const hasExtension = path.extname(command).length > 0;
  const pathExtRaw =
    env.PATHEXT ??
    env.Pathext ??
    process.env.PATHEXT ??
    process.env.Pathext ??
    ".EXE;.CMD;.BAT;.COM";
  const pathExt = hasExtension
    ? [""]
    : pathExtRaw
        .split(";")
        .map((ext) => ext.trim())
        .filter(Boolean)
        .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));

  for (const dir of pathEntries) {
    for (const ext of pathExt) {
      for (const candidateExt of [ext, ext.toLowerCase(), ext.toUpperCase()]) {
        const candidate = path.join(dir, `${command}${candidateExt}`);
        if (isFilePath(candidate)) {
          return candidate;
        }
      }
    }
  }

  return command;
}

function resolveNodeEntrypointFromCmdShim(wrapperPath: string): string | null {
  if (!isFilePath(wrapperPath)) {
    return null;
  }
  try {
    const content = readFileSync(wrapperPath, "utf8");
    const candidates: string[] = [];
    for (const match of content.matchAll(/"([^"\r\n]*)"/g)) {
      const token = match[1] ?? "";
      const relMatch = token.match(/%~?dp0%?\s*[\\/]*(.*)$/i);
      const relative = relMatch?.[1]?.trim();
      if (!relative) {
        continue;
      }
      const normalizedRelative = relative.replace(/[\\/]+/g, path.sep).replace(/^[\\/]+/, "");
      const candidate = path.resolve(path.dirname(wrapperPath), normalizedRelative);
      if (isFilePath(candidate)) {
        candidates.push(candidate);
      }
    }
    const nonNode = candidates.find((candidate) => {
      const base = path.basename(candidate).toLowerCase();
      return base !== "node.exe" && base !== "node";
    });
    return nonNode ?? null;
  } catch {
    return null;
  }
}

export function resolveSpawnCommand(
  params: { command: string; args: string[] },
  runtime: SpawnRuntime = DEFAULT_RUNTIME,
): ResolvedSpawnCommand {
  if (runtime.platform !== "win32") {
    return { command: params.command, args: params.args };
  }

  const resolvedCommand = resolveWindowsExecutablePath(params.command, runtime.env);
  const extension = path.extname(resolvedCommand).toLowerCase();
  if (extension === ".js" || extension === ".cjs" || extension === ".mjs") {
    return {
      command: runtime.execPath,
      args: [resolvedCommand, ...params.args],
      windowsHide: true,
    };
  }

  if (extension === ".cmd" || extension === ".bat") {
    const entrypoint = resolveNodeEntrypointFromCmdShim(resolvedCommand);
    if (entrypoint) {
      const entryExt = path.extname(entrypoint).toLowerCase();
      if (entryExt === ".exe") {
        return {
          command: entrypoint,
          args: params.args,
          windowsHide: true,
        };
      }
      return {
        command: runtime.execPath,
        args: [entrypoint, ...params.args],
        windowsHide: true,
      };
    }
    // Preserve compatibility for non-npm wrappers we cannot safely unwrap.
    return {
      command: resolvedCommand,
      args: params.args,
      shell: true,
    };
  }

  return {
    command: resolvedCommand,
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
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: resolved.shell,
    windowsHide: resolved.windowsHide,
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
