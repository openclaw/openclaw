import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function readWindowsEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const matchedKey = Object.keys(env).find((entry) => entry.toUpperCase() === key);
  return matchedKey ? env[matchedKey] : undefined;
}

function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const extensions = (readWindowsEnvValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  const commandExtension = path.extname(command);
  const candidates =
    commandExtension.length > 0
      ? [command]
      : extensions.map((extension) => `${command}${extension}`);
  const hasPath = command.includes("/") || command.includes("\\") || path.isAbsolute(command);

  if (hasPath) {
    return candidates.find((candidate) => fs.existsSync(candidate));
  }

  const pathValue = readWindowsEnvValue(env, "PATH");
  if (!pathValue) {
    return undefined;
  }

  for (const directory of pathValue.split(";")) {
    const trimmedDirectory = directory.trim();
    if (trimmedDirectory.length === 0) {
      continue;
    }
    for (const candidate of candidates) {
      const resolved = path.join(trimmedDirectory, candidate);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }
  }

  return undefined;
}

function shouldUseWindowsBatchShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== "win32") {
    return false;
  }
  const resolvedCommand = resolveWindowsCommand(command, env) ?? command;
  const ext = path.extname(resolvedCommand).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

export function buildSpawnCommandOptions(
  command: string,
  options: Parameters<typeof spawn>[2],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Parameters<typeof spawn>[2] {
  if (!shouldUseWindowsBatchShell(command, platform, env)) {
    return options;
  }
  return {
    ...options,
    shell: true,
  };
}
