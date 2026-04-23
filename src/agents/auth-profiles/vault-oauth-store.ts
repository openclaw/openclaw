/**
 * Vault-backed OAuth credential store for OpenAI Codex.
 *
 * Authenticates against Vault using the dedicated AppRole credentials stored at
 * VAULT_CODEX_APPROLE_PATH, then reads / writes the openai-codex OAuth
 * credential at kv-admin/openclaw/openai.  The Vault token obtained from AppRole
 * login is cached in memory for its lifetime so we do not re-authenticate on
 * every operation.
 *
 * Vault server  : https://10.40.0.77:8200
 * AppRole path  : /home/cleo/.config/openclaw/vault-codex-approle
 * KV path       : kv-admin/openclaw/openai
 * CA cert       : /etc/ssl/certs/vault-ca.pem
 *
 * Read path uses the same AppRole token against the vault-agent proxy at
 * 127.0.0.1:8212 (which caches KV reads), falling back to direct Vault if the
 * proxy is unreachable.
 */

import fs from "node:fs";
import https from "node:https";
import { OPENAI_CODEX_DEFAULT_PROFILE_ID } from "./constants.js";
import { log } from "./constants.js";
import type { RuntimeExternalOAuthProfile } from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

// ── Config constants ──────────────────────────────────────────────────────────

const VAULT_ADDR = "https://10.40.0.77:8200";
const VAULT_AGENT_READ_ADDR = "https://127.0.0.1:8212";
const VAULT_CA_CERT_PATH = "/etc/ssl/certs/vault-ca.pem";
const VAULT_KV_API_PATH = "/v1/kv-admin/data/openclaw/openai";
const VAULT_APPROLE_LOGIN_PATH = "/v1/auth/approle/login";

/**
 * Primary location for the codex AppRole credentials.
 * Falls back to the legacy agent-dir location if not present.
 */
const VAULT_CODEX_APPROLE_PATH = "/home/cleo/.config/openclaw/vault-codex-approle";
const VAULT_CODEX_APPROLE_FALLBACK = "/home/cleo/.openclaw/agents/main/agent/.vault-approle";

const VAULT_BACKED_PROVIDER = "openai-codex";

/** Re-use a cached Vault token until this many ms before it expires. */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
/** How long to keep a KV credential in memory before re-fetching from Vault. */
const CREDENTIAL_CACHE_TTL_MS = 5 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

type AppRoleCreds = { roleId: string; secretId: string };

type VaultTokenCache = {
  token: string;
  /** Unix ms at which the token expires (based on lease_duration). */
  expiresAt: number;
  renewable: boolean;
};

type CredentialCache = {
  credential: OAuthCredential;
  profileId: string;
  readAt: number;
};

type VaultKvData = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
  email?: string;
  /** Stored on every write so the profile ID survives a restart. */
  profile_id?: string;
  expires_ms?: number;
  last_refresh?: string;
  auth_mode?: string;
};

// ── Module-level cache state ──────────────────────────────────────────────────

let tokenCache: VaultTokenCache | null = null;
let credentialCache: CredentialCache | null = null;

// ── AppRole credential file ───────────────────────────────────────────────────

function readAppRoleCreds(): AppRoleCreds | null {
  const paths = [VAULT_CODEX_APPROLE_PATH, VAULT_CODEX_APPROLE_FALLBACK];
  for (const p of paths) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const roleId = raw.match(/^role_id=(.+)$/m)?.[1]?.trim();
      const secretId = raw.match(/^secret_id=(.+)$/m)?.[1]?.trim();
      if (roleId && secretId) {
        return { roleId, secretId };
      }
    } catch {
      // try next path
    }
  }
  return null;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function readCaCert(): Buffer | undefined {
  try {
    return fs.readFileSync(VAULT_CA_CERT_PATH);
  } catch {
    return undefined;
  }
}

function httpsRequest(
  baseUrl: string,
  options: {
    path: string;
    method: "GET" | "POST";
    headers?: Record<string, string | number>;
    body?: string;
  },
): Promise<unknown> {
  const url = new URL(options.path, baseUrl);
  const ca = readCaCert();

  return new Promise((resolve, reject) => {
    const reqOptions: https.RequestOptions = {
      hostname: url.hostname,
      port: Number(url.port) || 443,
      path: url.pathname + url.search,
      method: options.method,
      headers: options.headers,
      ...(ca ? { ca } : {}),
    };

    const req = https.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(raw);
          }
        } else {
          reject(
            new Error(
              `Vault ${options.method} ${options.path} → HTTP ${res.statusCode}: ${raw.slice(0, 200)}`,
            ),
          );
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error("Vault request timed out after 10s"));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ── AppRole login / token management ─────────────────────────────────────────

function isTokenUsable(): boolean {
  if (!tokenCache) {
    return false;
  }
  return Date.now() < tokenCache.expiresAt - TOKEN_EXPIRY_BUFFER_MS;
}

async function getVaultToken(): Promise<string> {
  if (isTokenUsable()) {
    return tokenCache!.token;
  }

  const creds = readAppRoleCreds();
  if (!creds) {
    throw new Error(`vault-oauth: AppRole credentials not found at ${VAULT_CODEX_APPROLE_PATH}`);
  }

  const body = JSON.stringify({ role_id: creds.roleId, secret_id: creds.secretId });
  const resp = (await httpsRequest(VAULT_ADDR, {
    path: VAULT_APPROLE_LOGIN_PATH,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    body,
  })) as { auth?: { client_token?: string; lease_duration?: number; renewable?: boolean } };

  const token = resp?.auth?.client_token;
  if (!token) {
    throw new Error("vault-oauth: AppRole login did not return a client_token");
  }

  const leaseSec = resp.auth?.lease_duration ?? 3600;
  tokenCache = {
    token,
    expiresAt: Date.now() + leaseSec * 1000,
    renewable: resp.auth?.renewable ?? false,
  };

  log.info("vault-oauth: obtained new Vault token via AppRole", {
    leaseDuration: leaseSec,
    renewable: tokenCache.renewable,
  });

  return token;
}

// ── KV helpers ────────────────────────────────────────────────────────────────

function decodeJwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" && payload.exp > 0 ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function vaultDataToCredential(data: VaultKvData): OAuthCredential | null {
  const access = data.access_token?.trim();
  const refresh = data.refresh_token?.trim();
  if (!access || !refresh) {
    return null;
  }

  const expires = data.expires_ms ?? decodeJwtExpiryMs(access) ?? Date.now() + 60 * 60 * 1000;

  return {
    type: "oauth",
    provider: VAULT_BACKED_PROVIDER,
    access,
    refresh,
    expires,
    ...(data.id_token?.trim() ? { idToken: data.id_token.trim() } : {}),
    ...(data.account_id?.trim() ? { accountId: data.account_id.trim() } : {}),
    ...(data.email?.trim() ? { email: data.email.trim() } : {}),
  };
}

function credentialToVaultData(credential: OAuthCredential, profileId: string): VaultKvData {
  return {
    access_token: credential.access,
    refresh_token: credential.refresh,
    ...(credential.idToken ? { id_token: credential.idToken } : {}),
    ...(credential.accountId ? { account_id: credential.accountId } : {}),
    ...(credential.email ? { email: credential.email } : {}),
    profile_id: profileId,
    expires_ms: credential.expires,
    last_refresh: new Date().toISOString(),
    auth_mode: "chatgpt",
  };
}

function resolveProfileId(data: VaultKvData, existingStore?: AuthProfileStore): string {
  if (data.profile_id?.trim()) {
    return data.profile_id.trim();
  }

  // Migration: match by accountId in the current store
  if (data.account_id && existingStore) {
    const accountId = data.account_id.trim();
    for (const [profileId, cred] of Object.entries(existingStore.profiles)) {
      if (
        cred.type === "oauth" &&
        cred.provider === VAULT_BACKED_PROVIDER &&
        cred.accountId === accountId &&
        (cred as Record<string, unknown>).managedBy !== "codex-cli"
      ) {
        return profileId;
      }
    }
  }

  if (data.email?.trim()) {
    return `${VAULT_BACKED_PROVIDER}:${data.email.trim()}`;
  }
  if (data.account_id?.trim()) {
    return `${VAULT_BACKED_PROVIDER}:${data.account_id.trim()}`;
  }
  return OPENAI_CODEX_DEFAULT_PROFILE_ID;
}

// ── Public surface ────────────────────────────────────────────────────────────

/**
 * Returns true for openai-codex OAuth credentials managed by OpenClaw's own
 * login flow that should live in Vault rather than on disk.
 * Excludes credentials with managedBy="codex-cli" (sourced from ~/.codex).
 */
export function isVaultBackedOAuthProfile(
  _profileId: string,
  credential: { type: string; provider: string },
): boolean {
  if (credential.type !== "oauth") {
    return false;
  }
  if (credential.provider !== VAULT_BACKED_PROVIDER) {
    return false;
  }
  if ((credential as Record<string, unknown>).managedBy === "codex-cli") {
    return false;
  }
  return true;
}

/**
 * Reads the openai-codex OAuth credential from Vault.
 * Tries the vault-agent read proxy first (cached), falls back to direct Vault.
 * Returns the in-memory cached value if still fresh.
 */
export async function readVaultOAuthCredential(
  existingStore?: AuthProfileStore,
): Promise<OAuthCredential | null> {
  if (credentialCache && Date.now() - credentialCache.readAt < CREDENTIAL_CACHE_TTL_MS) {
    return credentialCache.credential;
  }

  const token = await getVaultToken().catch((err: unknown) => {
    log.warn("vault-oauth: cannot get Vault token for read", { err: String(err) });
    return null;
  });
  if (!token) {
    return null;
  }

  // Try the caching vault-agent proxy first; fall back to direct Vault on failure.
  const readTargets = [VAULT_AGENT_READ_ADDR, VAULT_ADDR];
  for (const base of readTargets) {
    try {
      const resp = (await httpsRequest(base, {
        path: VAULT_KV_API_PATH,
        method: "GET",
        headers: { "X-Vault-Token": token },
      })) as { data?: { data?: VaultKvData } };

      const data = resp?.data?.data;
      if (!data) {
        log.warn("vault-oauth: vault response missing data", { base });
        continue;
      }

      const credential = vaultDataToCredential(data);
      if (!credential) {
        log.warn("vault-oauth: secret missing access_token or refresh_token", { base });
        continue;
      }

      const profileId = resolveProfileId(data, existingStore);
      credentialCache = { credential, profileId, readAt: Date.now() };
      log.info("vault-oauth: loaded openai-codex credential from vault", {
        via: base,
        profileId,
        expires: new Date(credential.expires).toISOString(),
      });
      return credential;
    } catch (err) {
      log.warn("vault-oauth: read attempt failed", { base, err: String(err) });
    }
  }

  return null;
}

/** Returns the cached credential entry, or null if stale / absent. Sync. */
export function getCachedVaultOAuthCredential(): CredentialCache | null {
  if (!credentialCache || Date.now() - credentialCache.readAt >= CREDENTIAL_CACHE_TTL_MS) {
    return null;
  }
  return credentialCache;
}

/**
 * Writes an openai-codex OAuth credential to Vault using the AppRole token.
 * Throws on failure so callers can decide how to surface it.
 */
export async function writeVaultOAuthCredential(
  profileId: string,
  credential: OAuthCredential,
): Promise<void> {
  const token = await getVaultToken();
  const body = JSON.stringify({ data: credentialToVaultData(credential, profileId) });

  await httpsRequest(VAULT_ADDR, {
    path: VAULT_KV_API_PATH,
    method: "POST",
    headers: {
      "X-Vault-Token": token,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  });

  credentialCache = { credential, profileId, readAt: Date.now() };
  log.info("vault-oauth: wrote openai-codex credential to vault", {
    profileId,
    expires: new Date(credential.expires).toISOString(),
  });
}

/**
 * Returns vault-backed credentials as runtime-only external profiles for the
 * auth overlay mechanism. Returns [] if the cache is empty or stale.
 */
export function resolveVaultOAuthExternalProfiles(): RuntimeExternalOAuthProfile[] {
  const cached = getCachedVaultOAuthCredential();
  if (!cached) {
    return [];
  }
  return [
    { profileId: cached.profileId, credential: cached.credential, persistence: "runtime-only" },
  ];
}

/**
 * Kicks off a background Vault read to warm the credential cache.
 * Errors are logged and suppressed — never blocks startup.
 */
export function warmVaultOAuthCache(existingStore?: AuthProfileStore): void {
  readVaultOAuthCredential(existingStore).catch((err: unknown) => {
    log.warn("vault-oauth: background cache warm failed", { err: String(err) });
  });
}

/** Forces the credential cache to expire; next read re-fetches from Vault. */
export function invalidateVaultOAuthCache(): void {
  credentialCache = null;
}
