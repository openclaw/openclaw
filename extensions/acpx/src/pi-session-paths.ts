import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function piHome(env: NodeJS.ProcessEnv): string {
  const configured = process.platform === "win32" ? env.USERPROFILE?.trim() : env.HOME?.trim();
  return configured || os.homedir();
}

export function isPiSessionCatalogPathAbsolute(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") {
    return path.posix.isAbsolute(value);
  }
  const root = path.win32.parse(value).root;
  return path.win32.isAbsolute(value) && root !== "\\" && root !== "/";
}

function resolveConfiguredPath(value: string, env: NodeJS.ProcessEnv): string {
  const home = piHome(env);
  let resolved = value;
  if (value === "~") {
    resolved = home;
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    resolved = path.join(home, value.slice(2));
  }
  if (!isPiSessionCatalogPathAbsolute(resolved)) {
    throw new Error("Pi session catalog requires absolute or home-relative storage paths");
  }
  return path.resolve(resolved);
}

function settingsSessionDir(file: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isRecord(value) ? optionalString(value.sessionDir, 4_096) : undefined;
  } catch {
    return undefined;
  }
}

export function piSessionStore(env: NodeJS.ProcessEnv): { root: string; flat: boolean } {
  const customSessionDir = env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (customSessionDir) {
    return { root: resolveConfiguredPath(customSessionDir, env), flat: true };
  }
  const home = piHome(env);
  const agentDir = env.PI_CODING_AGENT_DIR?.trim()
    ? resolveConfiguredPath(env.PI_CODING_AGENT_DIR, env)
    : path.join(home, ".pi", "agent");
  const configuredSessionDir =
    settingsSessionDir(path.join(process.cwd(), ".pi", "settings.json")) ??
    settingsSessionDir(path.join(agentDir, "settings.json"));
  if (configuredSessionDir) {
    return { root: resolveConfiguredPath(configuredSessionDir, env), flat: true };
  }
  return {
    root: path.join(agentDir, "sessions"),
    flat: false,
  };
}

export function piSessionStoreAvailable(env: NodeJS.ProcessEnv): boolean {
  try {
    return statSync(piSessionStore(env).root).isDirectory();
  } catch {
    return false;
  }
}
