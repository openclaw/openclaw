import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import type { ResolvedGoogleChatAccount } from "./accounts.js";

const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const CHAT_ISSUER = "chat@system.gserviceaccount.com";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
// Google Workspace Add-ons use a different service account pattern
const ADDON_ISSUER_PATTERN = /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;
const CHAT_CERTS_URL =
  "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";

// Size-capped to prevent unbounded growth in long-running deployments (#4948)
const MAX_AUTH_CACHE_SIZE = 32;
const authCache = new Map<string, { key: string; auth: GoogleAuth }>();
const serviceTokenCache = new Map<string, { accessToken: string; expiresAtMs: number }>();
const verifyClient = new OAuth2Client();

let cachedCerts: { fetchedAt: number; certs: Record<string, string> } | null = null;

type GoogleServiceAccountCredentials = {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
};

function evictOldestCacheEntry<T>(cache: Map<string, T>) {
  if (cache.size > MAX_AUTH_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
}

function buildAuthKey(account: ResolvedGoogleChatAccount): string {
  if (account.credentialsFile) {
    return `file:${account.credentialsFile}`;
  }
  if (account.credentials) {
    return `inline:${JSON.stringify(account.credentials)}`;
  }
  return `none:${account.accountId}`;
}

function getAuthInstance(account: ResolvedGoogleChatAccount): GoogleAuth {
  const key = buildAuthKey(account);
  const cached = authCache.get(account.accountId);
  if (cached && cached.key === key) {
    return cached.auth;
  }

  const auth = new GoogleAuth({ scopes: [CHAT_SCOPE] });
  authCache.set(account.accountId, { key, auth });
  evictOldestCacheEntry(authCache);
  return auth;
}

async function readServiceAccountCredentials(
  account: ResolvedGoogleChatAccount,
): Promise<GoogleServiceAccountCredentials | null> {
  if (account.credentials && typeof account.credentials === "object") {
    return account.credentials as GoogleServiceAccountCredentials;
  }
  if (!account.credentialsFile) {
    return null;
  }
  const raw = await readFile(account.credentialsFile, "utf8");
  return JSON.parse(raw) as GoogleServiceAccountCredentials;
}

function requireServiceAccountField(
  value: string | undefined,
  field: keyof GoogleServiceAccountCredentials,
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Google Chat service account is missing ${field}`);
  }
  return trimmed;
}

function toBase64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function buildServiceAccountAssertion(params: {
  credentials: GoogleServiceAccountCredentials;
  tokenUri: string;
  nowMs: number;
}): string {
  const { credentials, tokenUri, nowMs } = params;
  const clientEmail = requireServiceAccountField(credentials.client_email, "client_email");
  const privateKey = requireServiceAccountField(credentials.private_key, "private_key");
  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAt = issuedAt + 3600;

  const encodedHeader = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = toBase64Url(
    JSON.stringify({
      iss: clientEmail,
      scope: CHAT_SCOPE,
      aud: tokenUri,
      iat: issuedAt,
      exp: expiresAt,
    }),
  );
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();
  const signature = signer.sign(privateKey);
  return `${unsignedToken}.${toBase64Url(signature)}`;
}

async function exchangeServiceAccountAccessToken(params: {
  authKey: string;
  credentials: GoogleServiceAccountCredentials;
}): Promise<string> {
  const tokenUri = (params.credentials.token_uri?.trim() || DEFAULT_TOKEN_URI).trim();
  const parsedTokenUrl = new URL(tokenUri);
  if (parsedTokenUrl.protocol !== "https:") {
    throw new Error(`Google Chat token_uri must use https: ${tokenUri}`);
  }

  const nowMs = Date.now();
  const assertion = buildServiceAccountAssertion({
    credentials: params.credentials,
    tokenUri,
    nowMs,
  });
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google Chat token exchange ${res.status}: ${text || res.statusText}`);
  }

  const payload = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  const accessToken = payload.access_token?.trim();
  if (!accessToken) {
    throw new Error("Google Chat token exchange returned no access_token");
  }
  const expiresInSec =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? Math.max(60, payload.expires_in)
      : 3600;
  const expiresAtMs = nowMs + Math.max(30_000, (expiresInSec - 60) * 1000);
  serviceTokenCache.set(params.authKey, { accessToken, expiresAtMs });
  evictOldestCacheEntry(serviceTokenCache);
  return accessToken;
}

async function getServiceAccountAccessToken(
  account: ResolvedGoogleChatAccount,
): Promise<string | null> {
  const authKey = buildAuthKey(account);
  const cached = serviceTokenCache.get(authKey);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.accessToken;
  }

  const credentials = await readServiceAccountCredentials(account);
  if (!credentials) {
    return null;
  }
  return await exchangeServiceAccountAccessToken({ authKey, credentials });
}

export async function getGoogleChatAccessToken(
  account: ResolvedGoogleChatAccount,
): Promise<string> {
  const serviceAccountToken = await getServiceAccountAccessToken(account);
  if (serviceAccountToken) {
    return serviceAccountToken;
  }

  const auth = getAuthInstance(account);
  const client = await auth.getClient();
  const access = await client.getAccessToken();
  const token = typeof access === "string" ? access : access?.token;
  if (!token) {
    throw new Error("Missing Google Chat access token");
  }
  return token;
}

async function fetchChatCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedCerts && now - cachedCerts.fetchedAt < 10 * 60 * 1000) {
    return cachedCerts.certs;
  }
  const res = await fetch(CHAT_CERTS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch Chat certs (${res.status})`);
  }
  const certs = (await res.json()) as Record<string, string>;
  cachedCerts = { fetchedAt: now, certs };
  return certs;
}

export type GoogleChatAudienceType = "app-url" | "project-number";

export async function verifyGoogleChatRequest(params: {
  bearer?: string | null;
  audienceType?: GoogleChatAudienceType | null;
  audience?: string | null;
}): Promise<{ ok: boolean; reason?: string }> {
  const bearer = params.bearer?.trim();
  if (!bearer) {
    return { ok: false, reason: "missing token" };
  }
  const audience = params.audience?.trim();
  if (!audience) {
    return { ok: false, reason: "missing audience" };
  }
  const audienceType = params.audienceType ?? null;

  if (audienceType === "app-url") {
    try {
      const ticket = await verifyClient.verifyIdToken({
        idToken: bearer,
        audience,
      });
      const payload = ticket.getPayload();
      const email = payload?.email ?? "";
      const ok =
        payload?.email_verified && (email === CHAT_ISSUER || ADDON_ISSUER_PATTERN.test(email));
      return ok ? { ok: true } : { ok: false, reason: `invalid issuer: ${email}` };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "invalid token" };
    }
  }

  if (audienceType === "project-number") {
    try {
      const certs = await fetchChatCerts();
      await verifyClient.verifySignedJwtWithCertsAsync(bearer, certs, audience, [CHAT_ISSUER]);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "invalid token" };
    }
  }

  return { ok: false, reason: "unsupported audience type" };
}

export const GOOGLE_CHAT_SCOPE = CHAT_SCOPE;
