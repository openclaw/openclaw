import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Resolve ~/.openclaw/credentials.json path.
 * This is where auth profiles (API keys, OAuth tokens, etc.) are stored.
 */
export function resolveCredentialsPath(): string {
  const base = process.env.OPENCLAW_DIR || join(homedir(), ".openclaw");
  return join(base, "credentials.json");
}

/**
 * Resolve ~/.openclaw/openclaw.json path.
 */
export function resolveConfigPath(): string {
  const envPath = process.env.OPENCLAW_CONFIG;
  if (envPath) {
    return envPath;
  }
  return join(homedir(), ".openclaw", "openclaw.json");
}

/**
 * AuthProfileStore type (simplified)
 */
export type AuthProfile = {
  type: "api_key" | "oauth" | "token";
  provider: string;
  key?: string;
  token?: string;
  email?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
};

export type AuthProfileStore = {
  version: number;
  profiles: Record<string, AuthProfile>;
};

/**
 * Read the AuthProfileStore from credentials.json
 */
export function readAuthProfileStore(): AuthProfileStore {
  const credPath = resolveCredentialsPath();
  if (!existsSync(credPath)) {
    return { version: 1, profiles: {} };
  }
  try {
    const raw = readFileSync(credPath, "utf-8");
    return JSON.parse(raw) as AuthProfileStore;
  } catch {
    return { version: 1, profiles: {} };
  }
}

/**
 * Write the AuthProfileStore to credentials.json
 */
export function writeAuthProfileStore(store: AuthProfileStore): void {
  const credPath = resolveCredentialsPath();
  const dir = dirname(credPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(credPath, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

/**
 * Upsert an auth profile into the store.
 */
export function upsertAuthProfile(params: {
  profileId: string;
  credential: AuthProfile;
}): void {
  const store = readAuthProfileStore();
  store.profiles[params.profileId] = params.credential;
  writeAuthProfileStore(store);
}

/**
 * Read openclaw.json config.
 */
export function readConfig(): Record<string, unknown> {
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Write openclaw.json config.
 */
export function writeConfig(config: Record<string, unknown>): void {
  const configPath = resolveConfigPath();
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Apply auth profile config to openclaw.json (mirrors CLI logic).
 */
export function applyAuthProfileConfig(
  config: Record<string, unknown>,
  params: { profileId: string; provider: string; mode: "api_key" | "oauth" | "token" }
): Record<string, unknown> {
  const auth = (config.auth || {}) as Record<string, unknown>;
  const profiles = (auth.profiles || {}) as Record<string, Record<string, unknown>>;

  profiles[params.profileId] = {
    provider: params.provider,
    mode: params.mode,
  };

  auth.profiles = profiles;
  auth.provider = params.provider;

  return {
    ...config,
    auth,
  };
}
