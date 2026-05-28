import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandResult, RunOptions } from "./types.ts";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function say(message: string): void {
  process.stdout.write(`==> ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`warn: ${message}\n`);
}

export function die(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveWindowsExecutable(command: string, env: NodeJS.ProcessEnv): string {
  if (
    process.platform !== "win32" ||
    command.includes("/") ||
    command.includes("\\") ||
    path.isAbsolute(command)
  ) {
    return command;
  }
  if (path.extname(command)) {
    return command;
  }

  const pathValue = env.PATH ?? env.Path ?? process.env.PATH ?? process.env.Path ?? "";
  const pathExtRaw =
    env.PATHEXT ??
    env.Pathext ??
    process.env.PATHEXT ??
    process.env.Pathext ??
    ".EXE;.CMD;.BAT;.COM";
  const extensions = pathExtRaw
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));

  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidates = [ext, ext.toLowerCase(), ext.toUpperCase()];
      for (const candidateExt of candidates) {
        const candidate = path.join(dir, `${command}${candidateExt}`);
        if (isFile(candidate)) {
          return candidate;
        }
      }
    }
  }
  return command;
}

function isWindowsBatchCommand(command: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const ext = path.extname(command).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

function quoteWindowsCmdArg(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function resolveSpawnCommand(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const resolvedCommand = resolveWindowsExecutable(command, env);
  if (!isWindowsBatchCommand(resolvedCommand)) {
    return { command: resolvedCommand, args };
  }

  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      `call ${[resolvedCommand, ...args].map(quoteWindowsCmdArg).join(" ")}`,
    ],
    windowsVerbatimArguments: true,
  };
}

export function run(command: string, args: string[], options: RunOptions = {}): CommandResult {
  const env = { ...process.env, ...options.env };
  const spawnCommand = resolveSpawnCommand(command, args, env);
  const result = spawnSync(spawnCommand.command, spawnCommand.args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env,
    input: options.input,
    maxBuffer: 50 * 1024 * 1024,
    windowsVerbatimArguments: spawnCommand.windowsVerbatimArguments,
    stdio: options.quiet ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    timeout: options.timeoutMs,
  });

  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  if (result.error && !(timedOut && options.check === false)) {
    throw result.error;
  }

  const status = timedOut ? 124 : (result.status ?? (result.signal ? 128 : 1));
  const commandResult = {
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
    status,
  };
  if (options.check !== false && status !== 0) {
    if (commandResult.stdout) {
      process.stdout.write(commandResult.stdout);
    }
    if (commandResult.stderr) {
      process.stderr.write(commandResult.stderr);
    }
    die(`command failed (${status}): ${[command, ...args].join(" ")}`);
  }
  return commandResult;
}

export function sh(script: string, options: RunOptions = {}): CommandResult {
  return run("bash", ["-lc", script], options);
}

export async function runStreaming(
  command: string,
  args: string[],
  options: RunOptions & { logPath?: string } = {},
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    } satisfies SpawnOptions);

    let log = "";
    const append = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      log += text;
      if (!options.quiet) {
        process.stdout.write(text);
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      log += text;
      if (!options.quiet) {
        process.stderr.write(text);
      }
    });
    if (options.input != null) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }

    let timedOut = false;
    const timer =
      options.timeoutMs == null
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
          }, options.timeoutMs);

    child.on("error", reject);
    child.on("close", async (code, signal) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (options.logPath) {
        await writeFile(options.logPath, log, "utf8");
      }
      if (timedOut) {
        resolve(124);
      } else {
        resolve(code ?? (signal ? 128 : 1));
      }
    });
  });
}
