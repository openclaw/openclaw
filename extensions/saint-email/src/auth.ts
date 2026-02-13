import { createHash, createSign } from "node:crypto";
import type { ResolvedSaintEmailAccount, ResolvedSaintEmailOAuth2Config } from "./types.js";

const OAUTH2_TOKEN_REFRESH_SKEW_MS = 60_000;
const OAUTH2_JWT_TTL_SECONDS = 3600;
const OAUTH2_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";

type OAuth2CachedToken = {
  accessToken: string;
  expiresAtMs: number;
};

const oauth2TokenCache = new Map<string, OAuth2CachedToken>();

function toBase64Url(value: string | Buffer): string {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf-8");
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function normalizePrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, "\n").trim();
}

function buildOauth2CacheKey(params: {
  accountId: string;
  oauth2: ResolvedSaintEmailOAuth2Config;
}): string {
  const digest = createHash("sha256")
    .update(params.oauth2.privateKey, "utf-8")
    .digest("hex")
    .slice(0, 16);
  return [
    params.accountId,
    params.oauth2.serviceAccountEmail,
    params.oauth2.subject ?? "no-subject",
    params.oauth2.tokenUri,
    params.oauth2.scopes.join(" "),
    digest,
  ].join("::");
}

function buildServiceAccountAssertion(params: {
  oauth2: ResolvedSaintEmailOAuth2Config;
  nowMs: number;
}): string {
  const iat = Math.floor(params.nowMs / 1000);
  const exp = iat + OAUTH2_JWT_TTL_SECONDS;
  const payload: Record<string, unknown> = {
    iss: params.oauth2.serviceAccountEmail,
    scope: params.oauth2.scopes.join(" "),
    aud: params.oauth2.tokenUri,
    iat,
    exp,
  };
  if (params.oauth2.subject) {
    payload.sub = params.oauth2.subject;
  }
  const encodedHeader = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(normalizePrivateKey(params.oauth2.privateKey));
  return `${unsigned}.${toBase64Url(signature)}`;
}

async function exchangeServiceAccountToken(params: {
  oauth2: ResolvedSaintEmailOAuth2Config;
}): Promise<OAuth2CachedToken> {
  const assertion = buildServiceAccountAssertion({
    oauth2: params.oauth2,
    nowMs: Date.now(),
  });
  const body = new URLSearchParams({
    grant_type: OAUTH2_GRANT_TYPE,
    assertion,
  }).toString();

  const response = await fetch(params.oauth2.tokenUri, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const raw = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    throw new Error(
      `gmail oauth2 token exchange failed (${response.status}): ${raw || "empty response"}`,
    );
  }

  const accessToken =
    parsed && typeof parsed.access_token === "string" ? parsed.access_token.trim() : "";
  if (!accessToken) {
    throw new Error("gmail oauth2 token exchange returned no access_token");
  }
  const expiresIn =
    parsed && typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in)
      ? Math.max(60, Math.floor(parsed.expires_in))
      : OAUTH2_JWT_TTL_SECONDS;

  return {
    accessToken,
    expiresAtMs: Date.now() + expiresIn * 1000,
  };
}

function resolveOauth2Config(
  account: ResolvedSaintEmailAccount,
): ResolvedSaintEmailOAuth2Config | null {
  if (!account.oauth2?.serviceAccountEmail || !account.oauth2?.privateKey) {
    return null;
  }
  return account.oauth2;
}

export async function resolveGmailAccessToken(params: {
  account: ResolvedSaintEmailAccount;
}): Promise<{ token: string; source: "static" | "oauth2" }> {
  const staticToken = params.account.accessToken?.trim();
  if (staticToken) {
    return { token: staticToken, source: "static" };
  }

  const oauth2 = resolveOauth2Config(params.account);
  if (!oauth2) {
    throw new Error("email accessToken or oauth2 service account is not configured");
  }
  const cacheKey = buildOauth2CacheKey({
    accountId: params.account.accountId,
    oauth2,
  });
  const now = Date.now();
  const cached = oauth2TokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - now > OAUTH2_TOKEN_REFRESH_SKEW_MS) {
    return { token: cached.accessToken, source: "oauth2" };
  }

  const exchanged = await exchangeServiceAccountToken({ oauth2 });
  oauth2TokenCache.set(cacheKey, exchanged);
  return { token: exchanged.accessToken, source: "oauth2" };
}

export function invalidateGmailAccessToken(account: ResolvedSaintEmailAccount): void {
  const oauth2 = resolveOauth2Config(account);
  if (!oauth2) {
    return;
  }
  const cacheKey = buildOauth2CacheKey({
    accountId: account.accountId,
    oauth2,
  });
  oauth2TokenCache.delete(cacheKey);
}

export const __testing = {
  toBase64Url,
  normalizePrivateKey,
  buildServiceAccountAssertion,
  buildOauth2CacheKey,
};
