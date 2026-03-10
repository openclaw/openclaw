import crypto from "node:crypto";
import fs from "node:fs";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import type { ResolvedGoogleChatAccount } from "./accounts.js";

const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const CHAT_ISSUER = "chat@system.gserviceaccount.com";
// Google Workspace Add-ons use a different service account pattern
const ADDON_ISSUER_PATTERN = /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;
const CHAT_CERTS_URL =
  "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Size-capped to prevent unbounded growth in long-running deployments (#4948)
const MAX_AUTH_CACHE_SIZE = 32;
const authCache = new Map<string, { key: string; auth: GoogleAuth }>();
const verifyClient = new OAuth2Client();

let cachedCerts: { fetchedAt: number; certs: Record<string, string> } | null = null;

// Manual access token cache (bypasses broken gaxios)
const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();

function buildAuthKey(account: ResolvedGoogleChatAccount): string {
  if (account.credentialsFile) {
    return `file:${account.credentialsFile}`;
  }
  if (account.credentials) {
    return `inline:${JSON.stringify(account.credentials)}`;
  }
  return "none";
}

function getAuthInstance(account: ResolvedGoogleChatAccount): GoogleAuth {
  const key = buildAuthKey(account);
  const cached = authCache.get(account.accountId);
  if (cached && cached.key === key) {
    return cached.auth;
  }

  const evictOldest = () => {
    if (authCache.size > MAX_AUTH_CACHE_SIZE) {
      const oldest = authCache.keys().next().value;
      if (oldest !== undefined) {
        authCache.delete(oldest);
      }
    }
  };

  if (account.credentialsFile) {
    const auth = new GoogleAuth({ keyFile: account.credentialsFile, scopes: [CHAT_SCOPE] });
    authCache.set(account.accountId, { key, auth });
    evictOldest();
    return auth;
  }

  if (account.credentials) {
    const auth = new GoogleAuth({ credentials: account.credentials, scopes: [CHAT_SCOPE] });
    authCache.set(account.accountId, { key, auth });
    evictOldest();
    return auth;
  }

  const auth = new GoogleAuth({ scopes: [CHAT_SCOPE] });
  authCache.set(account.accountId, { key, auth });
  evictOldest();
  return auth;
}

/**
 * Load service account credentials from account config.
 * Returns { client_email, private_key } or null if not available.
 */
function loadServiceAccountCredentials(account: ResolvedGoogleChatAccount): {
  client_email: string;
  private_key: string;
} | null {
  if (account.credentialsFile) {
    try {
      const raw = fs.readFileSync(account.credentialsFile, "utf8");
      const sa = JSON.parse(raw) as { client_email?: string; private_key?: string };
      if (sa.client_email && sa.private_key) {
        return { client_email: sa.client_email, private_key: sa.private_key };
      }
    } catch {
      return null;
    }
  }
  if (account.credentials && typeof account.credentials === "object") {
    const sa = account.credentials as { client_email?: string; private_key?: string };
    if (sa.client_email && sa.private_key) {
      return { client_email: sa.client_email, private_key: sa.private_key };
    }
  }
  return null;
}

/**
 * Get Google Chat access token using manual JWT signing + OAuth2 token exchange.
 * This bypasses the broken gaxios@7.1.3 library used by google-auth-library.
 */
export async function getGoogleChatAccessToken(
  account: ResolvedGoogleChatAccount,
): Promise<string> {
  const sa = loadServiceAccountCredentials(account);
  if (!sa) {
    throw new Error("No service account credentials available for Google Chat");
  }

  const credentialFingerprint = crypto.createHash("md5").update(sa.private_key).digest("hex");
  const cacheKey = `${account.accountId}:${credentialFingerprint}`;
  const cached = accessTokenCache.get(cacheKey);
  const now = Math.floor(Date.now() / 1000);

  // Return cached token if still valid (with 5 min buffer)
  if (cached && cached.expiresAt > now + 300) {
    return cached.token;
  }

  // Create signed JWT assertion
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: sa.client_email,
      scope: CHAT_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  ).toString("base64url");

  const signInput = `${header}.${payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signInput);
  const signature = sign.sign(sa.private_key, "base64url");
  const jwt = `${signInput}.${signature}`;

  // Exchange JWT for access token
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google OAuth2 token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("Missing access_token in Google OAuth2 response");
  }

  // Cache the token
  accessTokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: now + (data.expires_in ?? 3600),
  });

  // Evict old entries
  if (accessTokenCache.size > MAX_AUTH_CACHE_SIZE) {
    const oldest = accessTokenCache.keys().next().value;
    if (oldest !== undefined) {
      accessTokenCache.delete(oldest);
    }
  }

  return data.access_token;
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

// Google OAuth2 JWKS endpoint for manual JWT verification
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
let cachedJwks: { fetchedAt: number; keys: Array<{ kid: string; [k: string]: unknown }> } | null =
  null;

async function fetchGoogleJwks(): Promise<Array<{ kid: string; [k: string]: unknown }>> {
  const now = Date.now();
  if (cachedJwks && now - cachedJwks.fetchedAt < 10 * 60 * 1000) {
    return cachedJwks.keys;
  }
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch Google JWKS (${res.status})`);
  }
  const data = (await res.json()) as { keys: Array<{ kid: string; [k: string]: unknown }> };
  cachedJwks = { fetchedAt: now, keys: data.keys };
  return data.keys;
}

async function manualVerifyGoogleJwt(
  idToken: string,
  expectedAudience: string,
): Promise<{
  ok: boolean;
  payload?: {
    iss?: string;
    aud?: string;
    email?: string;
    email_verified?: boolean;
    exp?: number;
    sub?: string;
  };
  reason?: string;
}> {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "invalid JWT format" };
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  let header: { kid?: string; alg?: string };
  let payload: {
    iss?: string;
    aud?: string;
    email?: string;
    email_verified?: boolean;
    exp?: number;
    sub?: string;
  };

  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  } catch {
    return { ok: false, reason: "failed to decode JWT" };
  }

  // Check algorithm
  if (header.alg !== "RS256") {
    return { ok: false, reason: `unsupported algorithm: ${header.alg}` };
  }

  // Check expiration
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "token expired" };
  }

  // Check audience
  if (payload.aud !== expectedAudience) {
    return {
      ok: false,
      reason: `audience mismatch: expected=${expectedAudience} got=${payload.aud}`,
    };
  }

  // Check issuer
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
    return { ok: false, reason: `invalid issuer: ${payload.iss}` };
  }

  // Verify signature using Google's JWKS
  const jwks = await fetchGoogleJwks();
  const key = jwks.find((k) => k.kid === header.kid);
  if (!key) {
    return { ok: false, reason: `no matching key found for kid=${header.kid}` };
  }

  const publicKey = crypto.createPublicKey({ key: key as any, format: "jwk" });
  const signedData = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(signatureB64, "base64url");

  const isValid = crypto.verify(
    header.alg === "RS256" ? "sha256" : "sha256",
    Buffer.from(signedData),
    publicKey,
    signature,
  );

  if (!isValid) {
    return { ok: false, reason: "signature verification failed" };
  }

  return { ok: true, payload };
}

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
      const result = await manualVerifyGoogleJwt(bearer, audience);
      if (!result.ok) {
        return { ok: false, reason: result.reason };
      }
      const email = result.payload?.email ?? "";
      const ok =
        result.payload?.email_verified &&
        (email === CHAT_ISSUER || ADDON_ISSUER_PATTERN.test(email));
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
