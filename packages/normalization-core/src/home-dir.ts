import os from "node:os";
import path from "node:path";

export function normalizeHomeDirValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "undefined" && trimmed !== "null" ? trimmed : undefined;
}

function normalizeSafe(homedir: () => string): string | undefined {
  try {
    return normalizeHomeDirValue(homedir());
  } catch {
    return undefined;
  }
}

function resolveTermuxHome(env: NodeJS.ProcessEnv): string | undefined {
  const prefix = normalizeHomeDirValue(env.PREFIX);
  if (!prefix || !normalizeHomeDirValue(env.ANDROID_DATA)) {
    return undefined;
  }
  if (!/(?:^|\/)com\.termux\/files\/usr\/?$/u.test(prefix.replace(/\\/gu, "/"))) {
    return undefined;
  }
  return path.resolve(prefix, "..", "home");
}

function resolveRawOsHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  return (
    normalizeHomeDirValue(env.HOME) ??
    normalizeHomeDirValue(env.USERPROFILE) ??
    resolveTermuxHome(env) ??
    normalizeSafe(homedir)
  );
}

export function resolveOsHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const raw = resolveRawOsHomeDir(env, homedir);
  return raw ? path.resolve(raw) : undefined;
}

export function resolveEffectiveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
  options?: { preserveUnresolvedTilde?: boolean },
): string | undefined {
  const explicitHome = normalizeHomeDirValue(env.OPENCLAW_HOME);
  if (!explicitHome) {
    return resolveOsHomeDir(env, homedir);
  }
  if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
    const osHome = resolveRawOsHomeDir(env, homedir);
    if (!osHome) {
      return options?.preserveUnresolvedTilde ? path.resolve(explicitHome) : undefined;
    }
    return path.resolve(explicitHome.replace(/^~(?=$|[\\/])/, () => osHome));
  }
  return path.resolve(explicitHome);
}
