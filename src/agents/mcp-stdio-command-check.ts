/**
 * Checks whether a stdio MCP server's launch command resolves to an
 * executable file, so a missing binary (e.g. `uvx` never installed) can be
 * reported with an actionable message instead of surfacing later as a
 * generic transport-level "Connection closed" error.
 */
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveEnvironmentValue } from "../infra/process-env.js";

function resolveConfiguredPath(filePath: string, cwd: unknown): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  // A meaningful cwd (or PATH entry, below) can contain significant leading
  // or trailing whitespace on POSIX; trimming only decides whether a value
  // was configured at all, never the literal bytes used to resolve it.
  const base = typeof cwd === "string" && cwd.trim().length > 0 ? cwd : process.cwd();
  return path.resolve(base, filePath);
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    // X_OK also succeeds for searchable directories; follow symlinks to check the target type.
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function executableCandidates(command: string): string[] {
  if (process.platform !== "win32") {
    return [command];
  }
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (path.extname(command)) {
    return [command];
  }
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

/** True when `command` resolves to an executable file, either directly or via `PATH`. */
export async function stdioCommandExists(
  command: string,
  cwd: unknown,
  env: Record<string, string> | undefined,
): Promise<boolean> {
  const hasPathSeparator =
    path.isAbsolute(command) || command.includes("/") || command.includes("\\");
  if (hasPathSeparator) {
    const resolvedPath = resolveConfiguredPath(command, cwd);
    // Node's own spawn (via libuv) tries PATHEXT suffixes for an explicit
    // path too, not just PATH-search candidates — an extensionless
    // `C:\Tools\uvx` successfully launches `C:\Tools\uvx.exe`. Match that so
    // this check doesn't reject a launch config the actual launcher accepts.
    for (const candidate of executableCandidates(resolvedPath)) {
      if (await isExecutable(candidate)) {
        return true;
      }
    }
    return false;
  }
  const configuredPath =
    process.platform === "win32" ? resolveEnvironmentValue(env, "PATH") : env?.PATH;
  // Only a truly empty segment means "current directory" in PATH semantics
  // (e.g. a leading/trailing/doubled delimiter); a non-empty entry keeps its
  // literal bytes, including any significant surrounding whitespace.
  const pathEntries = (configuredPath ?? process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => (entry === "" ? "." : entry));
  for (const pathEntry of pathEntries) {
    const resolvedPathEntry = path.isAbsolute(pathEntry)
      ? pathEntry
      : resolveConfiguredPath(pathEntry, cwd);
    for (const candidate of executableCandidates(command)) {
      if (await isExecutable(path.join(resolvedPathEntry, candidate))) {
        return true;
      }
    }
  }
  return false;
}
