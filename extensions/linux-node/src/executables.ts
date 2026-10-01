import fs from "node:fs";
import path from "node:path";

export type ExecutableResolver = (
  command: string,
  env: NodeJS.ProcessEnv,
  extraCandidates?: readonly string[],
) => string | null;

const cache = new Map<string, string | null>();

export const resolveExecutable: ExecutableResolver = (command, env, extraCandidates = []) => {
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
  const found =
    candidates.find((candidate) => {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }) ?? null;
  cache.set(key, found);
  return found;
};
