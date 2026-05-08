import { access, constants as fsConstants, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function expandHomeDir(input: string): string {
  if (!input.startsWith("~")) {
    return input;
  }
  const homeDir = os.homedir();
  if (input === "~") {
    return homeDir;
  }
  if (input.startsWith("~/") || input.startsWith(`~${path.sep}`)) {
    return path.join(homeDir, input.slice(2));
  }
  return input;
}

function hasPathSeparator(input: string): boolean {
  return input.includes(path.posix.sep) || input.includes(path.win32.sep);
}

function candidateExecutableNames(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  if (platform !== "win32") {
    return [command];
  }
  if (path.extname(command)) {
    return [command];
  }
  const pathext = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith(".") ? item : `.${item}`));
  return [command, ...new Set(pathext).values()].map((item, index) =>
    index === 0 ? item : `${command}${item}`,
  );
}

async function isExecutable(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const entry = await stat(filePath);
    if (!entry.isFile()) {
      return false;
    }
    if (platform === "win32") {
      return true;
    }
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveExecutablePath(params: {
  command: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<string | null> {
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const command = expandHomeDir(params.command.trim());
  if (!command) {
    return null;
  }

  if (hasPathSeparator(command)) {
    for (const candidate of candidateExecutableNames(command, platform, env)) {
      if (await isExecutable(candidate, platform)) {
        return candidate;
      }
    }
    return null;
  }

  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    const normalizedEntry = expandHomeDir(entry.trim().replace(/^"(.*)"$/, "$1"));
    if (!normalizedEntry) {
      continue;
    }
    for (const candidate of candidateExecutableNames(command, platform, env)) {
      const candidatePath = path.join(normalizedEntry, candidate);
      if (await isExecutable(candidatePath, platform)) {
        return candidatePath;
      }
    }
  }

  return null;
}
