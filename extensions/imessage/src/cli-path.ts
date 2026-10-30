import { constants, accessSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveRequiredHomeDir } from "openclaw/plugin-sdk/state-paths";
import { readNonBlankString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  expandIMessageHomePrefix,
  expandIMessageUserPath,
  resolveIMessageHomeDir,
} from "./user-path.js";

export { expandIMessageUserPath, resolveIMessageHomeDir };

const localCliPathCache = new Map<string, boolean>();
const MACH_O_MAGICS = new Set([
  "feedface",
  "feedfacf",
  "cefaedfe",
  "cffaedfe",
  "cafebabe",
  "cafebabf",
  "bebafeca",
  "bfbafeca",
]);

/**
 * Resolves a configured local path the way `resolveUserPath` does — a leading `~`
 * expands against the effective home, with its working-directory fallback when no
 * home exists, and the result becomes absolute — but keeps the literal bytes.
 * macOS permits trailing whitespace in file and directory names, so trimming here
 * would silently select a different path.
 */
export function resolveIMessageLiteralPath(value: string): string {
  return path.resolve(expandIMessageHomePrefix(value, resolveRequiredHomeDir()));
}

function resolveIMessageExecutable(cliPath: string): string | undefined {
  const expanded = expandIMessageUserPath(cliPath);
  if (expanded.includes(path.sep)) {
    return expanded;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, expanded);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH until an executable candidate is found.
    }
  }
  return undefined;
}

function isMachOExecutable(filePath: string): boolean {
  try {
    return MACH_O_MAGICS.has(readFileSync(filePath).subarray(0, 4).toString("hex"));
  } catch {
    return false;
  }
}

function isProvenLocalIMessageCliPath(params: { cliPath: string; remoteHost?: string }): boolean {
  if (params.remoteHost?.trim()) {
    return false;
  }
  const cliPath = readNonBlankString(params.cliPath) ?? "";
  const cacheKey = `${cliPath}\0${process.env.PATH ?? ""}`;
  const cached = localCliPathCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const executable = resolveIMessageExecutable(cliPath);
  let local = executable ? isMachOExecutable(executable) : false;
  if (executable && !local) {
    try {
      const wrapper = readFileSync(executable, "utf8");
      const match = wrapper.match(
        /^#![^\r\n]+\r?\n\s*exec\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+"\$@"\s*$/u,
      );
      const target = match?.[1] ?? match?.[2] ?? match?.[3];
      local = Boolean(target && path.isAbsolute(target) && isMachOExecutable(target));
    } catch {
      local = false;
    }
  }
  // CLI installation is process-stable channel metadata; avoid repeated file reads.
  localCliPathCache.set(cacheKey, local);
  return local;
}

function isLikelyLocalIMessageCliPath(rawCliPath: string): boolean {
  const cliPath = readNonBlankString(rawCliPath) ?? "";
  if (cliPath === "imsg") {
    return true;
  }
  if (path.basename(cliPath) !== "imsg") {
    return false;
  }
  try {
    return !/\bssh\b[\s\S]*\bimsg\b/u.test(readFileSync(expandIMessageUserPath(cliPath), "utf8"));
  } catch {
    return true;
  }
}

function defaultMessagesDbPath(): string | undefined {
  const home = resolveIMessageHomeDir();
  return home ? path.join(home, "Library", "Messages", "chat.db") : undefined;
}

export function resolveIMessageChatDbLookupPath(params: {
  cliPath: string;
  dbPath?: string;
  remoteHost?: string;
}): string | undefined {
  if (params.remoteHost?.trim()) {
    return undefined;
  }
  const configured = readNonBlankString(params.dbPath);
  if (configured) {
    return expandIMessageUserPath(configured);
  }
  // Receipt recovery is best effort and preserves the shipped wrapper heuristic.
  if (!isLikelyLocalIMessageCliPath(params.cliPath)) {
    return undefined;
  }
  return defaultMessagesDbPath();
}

export function resolveLocalIMessageChatDbPath(params: {
  cliPath: string;
  dbPath?: string;
  remoteHost?: string;
}): string | undefined {
  // Authorization may use chat.db only after positively attesting a local imsg executable.
  if (!isProvenLocalIMessageCliPath({ cliPath: params.cliPath, remoteHost: params.remoteHost })) {
    return undefined;
  }
  const configured = readNonBlankString(params.dbPath);
  return configured ? expandIMessageUserPath(configured) : defaultMessagesDbPath();
}
