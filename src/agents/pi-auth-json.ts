import fs from "node:fs/promises";
import path from "node:path";
import type { AuthProfileCredential } from "./auth-profiles/types.js";
import { ensureAuthProfileStore } from "./auth-profiles.js";

type AuthJsonCredential =
  | {
      type: "api_key";
      key: string;
    }
  | {
      type: "oauth";
      access: string;
      refresh: string;
      expires: number;
      [key: string]: unknown;
    };

type AuthJsonShape = Record<string, AuthJsonCredential>;

async function readAuthJson(filePath: string): Promise<AuthJsonShape> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed as AuthJsonShape;
  } catch {
    return {};
  }
}

/**
 * Convert an OpenClaw auth-profiles credential to pi-coding-agent auth.json format.
 * Returns null if the credential cannot be converted.
 */
function convertCredential(cred: AuthProfileCredential): AuthJsonCredential | null {
  if (cred.type === "api_key") {
    const key = typeof cred.key === "string" ? cred.key.trim() : "";
    if (!key) {
      return null;
    }
    return { type: "api_key", key };
  }

  if (cred.type === "token") {
    // pi-coding-agent treats static tokens as api_key type
    const token = typeof cred.token === "string" ? cred.token.trim() : "";
    if (!token) {
      return null;
    }
    return { type: "api_key", key: token };
  }

  if (cred.type === "oauth") {
    const accessRaw = (cred as { access?: unknown }).access;
    const refreshRaw = (cred as { refresh?: unknown }).refresh;
    const expiresRaw = (cred as { expires?: unknown }).expires;

    const access = typeof accessRaw === "string" ? accessRaw.trim() : "";
    const refresh = typeof refreshRaw === "string" ? refreshRaw.trim() : "";
    const expires = typeof expiresRaw === "number" ? expiresRaw : Number.NaN;

    if (!access || !refresh || !Number.isFinite(expires) || expires <= 0) {
      return null;
    }
    return { type: "oauth", access, refresh, expires };
  }

  return null;
}

/**
 * Check if two auth.json credentials are equivalent.
 */
function credentialsEqual(a: AuthJsonCredential | undefined, b: AuthJsonCredential): boolean {
  if (!a || typeof a !== "object") {
    return false;
  }
  if (a.type !== b.type) {
    return false;
  }

  if (a.type === "api_key" && b.type === "api_key") {
    return a.key === b.key;
  }

  if (a.type === "oauth" && b.type === "oauth") {
    return a.access === b.access && a.refresh === b.refresh && a.expires === b.expires;
  }

  return false;
}

/**
 * pi-coding-agent's ModelRegistry/AuthStorage expects credentials in auth.json.
 *
 * OpenClaw stores credentials in auth-profiles.json instead. This helper
 * bridges all credentials into agentDir/auth.json so pi-coding-agent can
 * (a) consider providers authenticated and (b) include built-in models in its
 * registry/catalog output.
 *
 * Syncs all credential types: api_key, token (as api_key), and oauth.
 */
export async function ensurePiAuthJsonFromAuthProfiles(agentDir: string): Promise<{
  wrote: boolean;
  authPath: string;
}> {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const authPath = path.join(agentDir, "auth.json");

  // Group profiles by provider, taking the first valid profile for each
  const providerCredentials = new Map<string, AuthJsonCredential>();

  for (const [, cred] of Object.entries(store.profiles)) {
    const provider = cred.provider;
    if (!provider || providerCredentials.has(provider)) {
      continue;
    }

    const converted = convertCredential(cred);
    if (converted) {
      providerCredentials.set(provider, converted);
    }
  }

  if (providerCredentials.size === 0) {
    return { wrote: false, authPath };
  }

  const existing = await readAuthJson(authPath);
  let changed = false;

  for (const [provider, cred] of providerCredentials) {
    if (!credentialsEqual(existing[provider], cred)) {
      existing[provider] = cred;
      changed = true;
    }
  }

  if (!changed) {
    return { wrote: false, authPath };
  }

  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(authPath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });

  return { wrote: true, authPath };
}
