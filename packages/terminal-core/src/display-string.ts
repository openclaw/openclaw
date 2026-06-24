// Terminal Core module implements display string behavior.
import os from "node:os";
import path from "node:path";

// Display-safe string helpers for shortening user home paths.

/** Normalize env/home values and reject shell placeholder strings. */
function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "undefined" && trimmed !== "null" ? trimmed : undefined;
}

/** Run a home resolver defensively because some runtimes throw for missing passwd data. */
function normalizeSafe(fn: () => string | undefined): string | undefined {
  try {
    return normalize(fn());
  } catch {
    return undefined;
  }
}

/** Resolve Termux home from its Android prefix layout. */
function resolveTermuxHome(env: NodeJS.ProcessEnv): string | undefined {
  const prefix = normalize(env.PREFIX);
  if (!prefix || !normalize(env.ANDROID_DATA)) {
    return undefined;
  }
  if (!/(?:^|\/)com\.termux\/files\/usr\/?$/u.test(prefix.replace(/\\/gu, "/"))) {
    return undefined;
  }
  return path.resolve(prefix, "..", "home");
}

/** Resolve the underlying OS home before applying OpenClaw overrides. */
function resolveRawOsHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  return (
    normalize(env.HOME) ??
    normalize(env.USERPROFILE) ??
    resolveTermuxHome(env) ??
    normalizeSafe(homedir)
  );
}

/** Resolve raw home with OPENCLAW_HOME tilde expansion. */
function resolveRawHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const explicitHome = normalize(env.OPENCLAW_HOME);
  if (explicitHome) {
    const fallbackHome = resolveRawOsHomeDir(env, homedir);
    return fallbackHome ? explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome) : explicitHome;
  }
  return resolveRawOsHomeDir(env, homedir);
}

/** Resolve the effective absolute home directory for display replacement. */
function resolveEffectiveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const raw = resolveRawHomeDir(env, homedir);
  return raw ? path.resolve(raw) : undefined;
}

/** Resolve the display prefix that should replace the effective home path. */
function resolveHomeDisplayPrefix(): { home: string; prefix: string } | undefined {
  const home = resolveEffectiveHomeDir();
  if (!home) {
    return undefined;
  }
  const explicitHome = process.env.OPENCLAW_HOME?.trim();
  return explicitHome ? { home, prefix: "$OPENCLAW_HOME" } : { home, prefix: "~" };
}

function isPathSegmentChar(char: string | undefined): boolean {
  return Boolean(char && /[\p{L}\p{M}\p{N}._~$-]/u.test(char));
}

function hasPathBoundaryBefore(input: string, index: number): boolean {
  return index === 0 || !isPathSegmentChar(input[index - 1]);
}

function hasPathBoundaryAfter(input: string, index: number): boolean {
  return index >= input.length || !isPathSegmentChar(input[index]);
}

function replaceHomePath(input: string, home: string, prefix: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < input.length) {
    const index = input.indexOf(home, cursor);
    if (index === -1) {
      result += input.slice(cursor);
      break;
    }

    const end = index + home.length;
    if (hasPathBoundaryBefore(input, index) && hasPathBoundaryAfter(input, end)) {
      result += input.slice(cursor, index) + prefix;
      cursor = end;
      continue;
    }

    result += input.slice(cursor, end);
    cursor = end;
  }

  return result;
}

/** Replace the effective home path with "~" or "$OPENCLAW_HOME" for terminal display. */
export function displayString(input: string): string {
  if (!input) {
    return input;
  }
  const display = resolveHomeDisplayPrefix();
  return display ? replaceHomePath(input, display.home, display.prefix) : input;
}
