import fs from "node:fs";
import path from "node:path";
import { canAccessSync } from "openclaw/plugin-sdk/path-existence-runtime";

export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  extraCandidates: readonly string[] = [],
): string | null {
  const pathValue = env.PATH ?? "";
  const pathCandidates = pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, command));
  const candidates = path.isAbsolute(command) ? [command] : [...pathCandidates, ...extraCandidates];
  return candidates.find((candidate) => canAccessSync(candidate, fs.constants.X_OK)) ?? null;
}
