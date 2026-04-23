/**
 * Vault-backed OAuth credential store for OpenAI Codex.
 *
 * Reads the openai-codex OAuth credential from Vault at runtime (via the dev
 * vault-agent proxy at 127.0.0.1:8212) and writes refreshed credentials back
 * to Vault directly (via the state-write vault token against 10.40.0.77:8200).
 *
 * This prevents plaintext OAuth secrets from being written to auth-profiles.json.
 *
 * Vault KV path : kv-admin/openclaw/openai
 * Read via      : 127.0.0.1:8212  (dev role, proxy)
 * Write via     : 10.40.0.77:8200 (direct, state-write token)
 * CA cert       : /etc/ssl/certs/vault-ca.pem
 */

import fs from "node:fs";
import https from "node:https";
import { OPENAI_CODEX_DEFAULT_PROFILE_ID } from "./constants.js";
import { log } from "./constants.js";
import type { RuntimeExternalOAuthProfile } from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

// ── Vault agent config ────────────────────────────────────────────────────────

const VAULT_CA_CERT_PATH = "/etc/ssl/certs/vault-ca.pem";

/** Dev vault-agent proxy: has read access to kv-admin/openclaw/openai */
const VAULT_READ_HOSTNAME = "127.0.0.1";
const VAULT_READ_PORT = 8212;
const VAULT_READ_TOKEN_FILE = "/run/openclaw-vault-agent/dev.token";

/** Direct Vault server: used for writes with the state-write token */
const VAULT_WRITE_HOSTNAME = "10.40.0.77";
const VAULT_WRITE_PORT = 8200;
const VAULT_WRITE_TOKEN_FILE = "/run/openclaw-vault-agent/state-write.token";

/** KV v2 API path for the openai secret */
const VAULT_KV_API_PATH = "/v1/kv-admin/data/openclaw/openai";

const VAULT_BACKED_PROVIDER = "openai-codex";

/** How long to trust a cached vault credential before re-fetching. */
const VAULT_CACHE_TTL_MS = 5 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

type VaultCacheEntry = {
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
  /** Profile ID stored on write so we can reconstruct it on read. */
  profile_id?: string;
  /** Expiry in ms since epoch, stored alongside JWT for precision. */
  expires_ms?: number;
  last_refresh?: string;
  auth_mode?: string;
};

// ── In-memory cache ───────────────────────────────────────────────────────────

let vaultCache: VaultCacheEntry | null = null;

// ── Profile identification ────────────────────────────────────────────────────

/**
 * Returns true for openai-codex OAuth credentials that OpenClaw itself owns
 * and that should be stored in Vault rather than on disk.
 *
 * Excludes credentials with `managedBy: "codex-cli"` — those are sourced
 * from ~/.codex by the external-cli-sync mechanism and have their own storage.
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

// ── Internal helpers ──────────────────────────────────────────────────────────

function readFileUtf8(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}

function readCaCert(): Buffer | undefined {
  try {
    return fs.readFileSync(VAULT_CA_CERT_PATH);
  } catch {
    return undefined;
  }
}

function httpsRequest(
  options: https.RequestOptions & {
    hostname: string;
    port: number;
    path: string;
    method: string;
  },
  body?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        const data = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(
            new Error(
              `Vault ${options.method} ${options.path} → HTTP ${res.statusCode}: ${data.slice(0, 200)}`,
            ),
          );
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error("Vault HTTP request timed out"));
    });
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

function decodeJwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const raw = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(raw) as { exp?: unknown };
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

/**
 * Derives the auth store profile ID from vault data.
 *
 * Priority:
 * 1. `profile_id` stored by a previous write (most reliable)
 * 2. Match by accountId against the existing store (migration path)
 * 3. email-based ID (`openai-codex:<email>`)
 * 4. accountId-based ID (`openai-codex:<accountId>`)
 * 5. Fallback to the default constant
 */
function resolveProfileId(data: VaultKvData, existingStore?: AuthProfileStore): string {
  if (data.profile_id?.trim()) {
    return data.profile_id.trim();
  }

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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Asynchronously reads the openai-codex OAuth credential from Vault.
 * Returns the cached value if it is still fresh.
 *
 * @param existingStore - Optional current auth store, used to match the correct
 *   profile ID during the one-time migration when `profile_id` is not yet stored
 *   in the Vault secret.
 */
export async function readVaultOAuthCredential(
  existingStore?: AuthProfileStore,
): Promise<OAuthCredential | null> {
  if (vaultCache && Date.now() - vaultCache.readAt < VAULT_CACHE_TTL_MS) {
    return vaultCache.credential;
  }

  const token = readFileUtf8(VAULT_READ_TOKEN_FILE);
  if (!token) {
    log.warn("vault-oauth: dev agent token not available, skipping vault read");
    return null;
  }

  const ca = readCaCert();

  try {
    const raw = await httpsRequest({
      hostname: VAULT_READ_HOSTNAME,
      port: VAULT_READ_PORT,
      path: VAULT_KV_API_PATH,
      method: "GET",
      headers: { "X-Vault-Token": token },
      ...(ca ? { ca } : { rejectUnauthorized: false }),
    });

    const parsed = JSON.parse(raw) as { data?: { data?: VaultKvData } };
    const data = parsed?.data?.data;
    if (!data) {
      log.warn("vault-oauth: vault response contained no data");
      return null;
    }

    const credential = vaultDataToCredential(data);
    if (!credential) {
      log.warn("vault-oauth: vault secret is missing access_token or refresh_token");
      return null;
    }

    const profileId = resolveProfileId(data, existingStore);
    vaultCache = { credential, profileId, readAt: Date.now() };
    log.info("vault-oauth: loaded openai-codex credential from vault", {
      profileId,
      expires: new Date(credential.expires).toISOString(),
    });
    return credential;
  } catch (err) {
    log.warn("vault-oauth: failed to read from vault agent", { err: String(err) });
    return null;
  }
}

/**
 * Returns the cached vault credential if still fresh, otherwise null.
 * Synchronous — does not contact Vault.
 */
export function getCachedVaultOAuthCredential(): VaultCacheEntry | null {
  if (!vaultCache || Date.now() - vaultCache.readAt >= VAULT_CACHE_TTL_MS) {
    return null;
  }
  return vaultCache;
}

/**
 * Writes an openai-codex OAuth credential back to Vault.
 * Uses the state-write token directly against the Vault server (not the proxy).
 * Throws on failure so callers can decide whether to surface or suppress the error.
 */
export async function writeVaultOAuthCredential(
  profileId: string,
  credential: OAuthCredential,
): Promise<void> {
  const token = readFileUtf8(VAULT_WRITE_TOKEN_FILE);
  if (!token) {
    throw new Error("vault-oauth: state-write token not available");
  }

  const ca = readCaCert();
  const body = JSON.stringify({ data: credentialToVaultData(credential, profileId) });

  await httpsRequest(
    {
      hostname: VAULT_WRITE_HOSTNAME,
      port: VAULT_WRITE_PORT,
      path: VAULT_KV_API_PATH,
      method: "POST",
      headers: {
        "X-Vault-Token": token,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      ...(ca ? { ca } : {}),
    },
    body,
  );

  // Keep the cache coherent with what was written
  vaultCache = { credential, profileId, readAt: Date.now() };
  log.info("vault-oauth: wrote openai-codex credential to vault", {
    profileId,
    expires: new Date(credential.expires).toISOString(),
  });
}

/**
 * Returns vault-backed credentials as RuntimeExternalOAuthProfile entries
 * for the external-auth overlay mechanism.
 * Returns an empty array if the cache is empty or stale.
 */
export function resolveVaultOAuthExternalProfiles(): RuntimeExternalOAuthProfile[] {
  const cached = getCachedVaultOAuthCredential();
  if (!cached) {
    return [];
  }
  return [
    {
      profileId: cached.profileId,
      credential: cached.credential,
      persistence: "runtime-only",
    },
  ];
}

/**
 * Kicks off a background vault read to warm the cache.
 * Safe to call at any time; errors are logged and swallowed.
 */
export function warmVaultOAuthCache(existingStore?: AuthProfileStore): void {
  readVaultOAuthCredential(existingStore).catch((err: unknown) => {
    log.warn("vault-oauth: background cache warm failed", { err: String(err) });
  });
}

/** Force-expires the cache so the next read re-fetches from Vault. */
export function invalidateVaultOAuthCache(): void {
  vaultCache = null;
}
