import fs from "node:fs";
import path from "node:path";
import { canAccessSync } from "openclaw/plugin-sdk/path-existence-runtime";

const cache = new Map<string, string | null>();

export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  extraCandidates: readonly string[] = [],
): string | null {
  const pathValue = env.PATH ?? "";
  const key = `${command}\0${pathValue}\0${extraCandidates.join("\0")}`;
  if (cache.has(key)) {
    return cache.get(key) ?? null;
  }

  const pathCandidates = pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, command));
  const candidates = path.isAbsolute(command) ? [command] : [...pathCandidates, ...extraCandidates];
  const found = candidates.find((candidate) => canAccessSync(candidate, fs.constants.X_OK)) ?? null;
  cache.set(key, found);
  return found;
}
