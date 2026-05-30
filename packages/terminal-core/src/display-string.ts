import os from "node:os";
import path from "node:path";

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "undefined" && trimmed !== "null" ? trimmed : undefined;
}

function normalizeSafe(fn: () => string | undefined): string | undefined {
  try {
    return normalize(fn());
  } catch {
    return undefined;
  }
}

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

function resolveRawOsHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  return (
    normalize(env.HOME) ??
    normalize(env.USERPROFILE) ??
    resolveTermuxHome(env) ??
    normalizeSafe(homedir)
  );
}

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

function resolveEffectiveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const raw = resolveRawHomeDir(env, homedir);
  return raw ? path.resolve(raw) : undefined;
}

function resolveHomeDisplayPrefix(): { home: string; prefix: string } | undefined {
  const home = resolveEffectiveHomeDir();
  if (!home) {
    return undefined;
  }
  const explicitHome = process.env.OPENCLAW_HOME?.trim();
  return explicitHome ? { home, prefix: "$OPENCLAW_HOME" } : { home, prefix: "~" };
}

function shortenHomeInString(input: string, display: { home: string; prefix: string }): string {
  if (input === display.home) {
    return display.prefix;
  }

  const { home, prefix } = display;
  let result = "";
  let index = 0;

  while (true) {
    const found = input.indexOf(home, index);
    if (found === -1) {
      result += input.slice(index);
      break;
    }

    const before = found === 0 ? null : input[found - 1];
    const after = input[found + home.length];
    const isValidBefore = before === null || /[\s:;"'<>()[\]{}]/.test(before);
    const isValidAfter =
      after === undefined || after === "/" || after === "\\" || /[\s:;"'<>()[\]{}]/.test(after);

    if (!isValidBefore || !isValidAfter) {
      result += input.slice(index, found + 1);
      index = found + 1;
      continue;
    }

    result += input.slice(index, found) + prefix;
    index = found + home.length;
  }

  return result;
}

export function displayString(input: string): string {
  if (!input) {
    return input;
  }
  const display = resolveHomeDisplayPrefix();
  return display ? shortenHomeInString(input, display) : input;
}
