/**
 * Vault-backed OAuth credential store for OpenAI Codex.
 *
 * Authenticates against Vault using the dedicated AppRole credentials stored at
 * VAULT_CODEX_APPROLE_PATH, then reads / writes the openai-codex OAuth
 * credential under the configured KV path.  The Vault token obtained from AppRole
 * login is cached in memory for its lifetime so we do not re-authenticate on
 * every operation.
 *
 * All paths and addresses are configurable via environment variables (see
 * "Config constants" section below).  Defaults match a typical single-node
 * deployment but must be overridden for other environments.
 *
 * Secret format (new nested):
 *   { OPENAI_API_KEY, last_refresh, tokens: { access_token, refresh_token, id_token, account_id } }
 *
 * Legacy flat format is still supported for reads.
 */

import fs from "node:fs";
import https from "node:https";
import { OPENAI_CODEX_DEFAULT_PROFILE_ID } from "./constants.js";
import { log } from "./constants.js";
import type { RuntimeExternalOAuthProfile } from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

// ── Config constants ─────────────────────────────────────────────────────────
//
// All values are read from environment variables at module load time.
// Standard Vault env vars (VAULT_ADDR, VAULT_CACERT) are honoured.
//
//   VAULT_ADDR                  Vault server URL
//                               default: https://10.40.0.77:8200
//   VAULT_AGENT_ADDR            Vault Agent local listener URL (tried first for reads)
//                               default: https://127.0.0.1:8212
//   VAULT_CACERT                Path to the CA certificate PEM file
//                               default: /etc/ssl/certs/vault-ca.pem
//   VAULT_KV_SECRET             KV v2 secret path in the form <mount>/<path>
//                               default: kv-admin/openclaw/openai
//   VAULT_APPROLE_MOUNT         Auth mount name for AppRole
//                               default: approle
//   VAULT_CODEX_APPROLE_PATH    Primary path to the AppRole role_id/secret_id file
//                               default: /home/cleo/.config/openclaw/vault-codex-approle
//   VAULT_CODEX_APPROLE_FALLBACK  Fallback path for the AppRole credentials file
//                               default: /home/cleo/.openclaw/agents/main/agent/.vault-approle

const VAULT_ADDR = process.env["VAULT_ADDR"] ?? "https://10.40.0.77:8200";
const VAULT_AGENT_READ_ADDR = process.env["VAULT_AGENT_ADDR"] ?? "https://127.0.0.1:8212";
const VAULT_CA_CERT_PATH = process.env["VAULT_CACERT"] ?? "/etc/ssl/certs/vault-ca.pem";

// KV v2 API path is derived from VAULT_KV_SECRET (<mount>/<path>)
// → /v1/<mount>/data/<path>
const _vaultKvSecret = process.env["VAULT_KV_SECRET"] ?? "kv-admin/openclaw/openai";
const [_kvMount, ..._kvRest] = _vaultKvSecret.split("/");
const VAULT_KV_API_PATH = `/v1/${_kvMount}/data/${_kvRest.join("/")}`;

const _vaultAppRoleMount = process.env["VAULT_APPROLE_MOUNT"] ?? "approle";
const VAULT_APPROLE_LOGIN_PATH = `/v1/auth/${_vaultAppRoleMount}/login`;

const VAULT_CODEX_APPROLE_PATH =
  process.env["VAULT_CODEX_APPROLE_PATH"] ?? "/home/cleo/.config/openclaw/vault-codex-approle";
const VAULT_CODEX_APPROLE_FALLBACK =
  process.env["VAULT_CODEX_APPROLE_FALLBACK"] ??
  "/home/cleo/.openclaw/agents/main/agent/.vault-approle";

const VAULT_BACKED_PROVIDER = "openai-codex";

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const CREDENTIAL_CACHE_TTL_MS = 5 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

type AppRoleCreds = { roleId: string; secretId: string };

type VaultTokenCache = {
  token: string;
  expiresAt: number;
  renewable: boolean;
};

type CredentialCache = {
  credential: OAuthCredential;
  profileId: string;
  readAt: number;
};

/** Nested tokens sub-object (new format). */
type VaultTokensBlock = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
};

/** Full KV secret data — supports both new nested and legacy flat formats. */
type VaultKvData = {
  // ── New nested format ──────────────────────────────────────────────────────
  tokens?: VaultTokensBlock;
  OPENAI_API_KEY?: string | null;
  // ── Legacy flat format (read-only compat) ──────────────────────────────────
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
  email?: string;
  profile_id?: string;
  expires_ms?: number;
  auth_mode?: string;
  last_refresh?: string;
};

// ── Module-level cache state ──────────────────────────────────────────────────

let tokenCache: VaultTokenCache | null = null;
let credentialCache: CredentialCache | null = null;

// ── AppRole credential file ───────────────────────────────────────────────────

function readAppRoleCreds(): AppRoleCreds | null {
  for (const p of [VAULT_CODEX_APPROLE_PATH, VAULT_CODEX_APPROLE_FALLBACK]) {
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
    const req = https.request(
      {
        hostname: url.hostname,
        port: Number(url.port) || 443,
        path: url.pathname + url.search,
        method: options.method,
        headers: options.headers,
        ...(ca ? { ca } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
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
      },
    );

    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("Vault request timed out after 10s")));
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ── AppRole login / token management ─────────────────────────────────────────

function isTokenUsable(): boolean {
  return !!tokenCache && Date.now() < tokenCache.expiresAt - TOKEN_EXPIRY_BUFFER_MS;
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

/**
 * Extracts OAuth fields from either the new nested format or legacy flat format.
 * New: data.tokens.access_token  Legacy: data.access_token
 */
function vaultDataToCredential(data: VaultKvData): OAuthCredential | null {
  const t = data.tokens;
  const access = (t?.access_token ?? data.access_token)?.trim();
  const refresh = (t?.refresh_token ?? data.refresh_token)?.trim();
  if (!access || !refresh) {
    return null;
  }

  const idToken = (t?.id_token ?? data.id_token)?.trim();
  const accountId = (t?.account_id ?? data.account_id)?.trim();
  const expires = data.expires_ms ?? decodeJwtExpiryMs(access) ?? Date.now() + 60 * 60 * 1000;

  return {
    type: "oauth",
    provider: VAULT_BACKED_PROVIDER,
    access,
    refresh,
    expires,
    ...(idToken ? { idToken } : {}),
    ...(accountId ? { accountId } : {}),
    ...(data.email?.trim() ? { email: data.email.trim() } : {}),
  };
}

/**
 * Serialises a credential back to the new nested format for writing to Vault.
 */
function credentialToVaultData(credential: OAuthCredential, _profileId: string): VaultKvData {
  return {
    OPENAI_API_KEY: null,
    last_refresh: new Date().toISOString(),
    tokens: {
      access_token: credential.access,
      refresh_token: credential.refresh,
      ...(credential.idToken ? { id_token: credential.idToken } : {}),
      ...(credential.accountId ? { account_id: credential.accountId } : {}),
    },
  };
}

function resolveProfileId(data: VaultKvData, existingStore?: AuthProfileStore): string {
  if (data.profile_id?.trim()) {
    return data.profile_id.trim();
  }

  // Resolve account_id from either format
  const accountId = (data.tokens?.account_id ?? data.account_id)?.trim();

  // Migration: match by accountId in the existing store
  if (accountId && existingStore) {
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
  if (accountId) {
    return `${VAULT_BACKED_PROVIDER}:${accountId}`;
  }
  return OPENAI_CODEX_DEFAULT_PROFILE_ID;
}

// ── Public surface ────────────────────────────────────────────────────────────

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

  for (const base of [VAULT_AGENT_READ_ADDR, VAULT_ADDR]) {
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

export function getCachedVaultOAuthCredential(): CredentialCache | null {
  if (!credentialCache || Date.now() - credentialCache.readAt >= CREDENTIAL_CACHE_TTL_MS) {
    return null;
  }
  return credentialCache;
}

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

export function resolveVaultOAuthExternalProfiles(): RuntimeExternalOAuthProfile[] {
  const cached = getCachedVaultOAuthCredential();
  if (!cached) {
    return [];
  }
  return [
    { profileId: cached.profileId, credential: cached.credential, persistence: "runtime-only" },
  ];
}

export function warmVaultOAuthCache(existingStore?: AuthProfileStore): void {
  readVaultOAuthCredential(existingStore).catch((err: unknown) => {
    log.warn("vault-oauth: background cache warm failed", { err: String(err) });
  });
}

export function invalidateVaultOAuthCache(): void {
  credentialCache = null;
}
