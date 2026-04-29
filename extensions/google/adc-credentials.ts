import { readFile } from "node:fs/promises";

export type AdcCredentials =
  | {
      type: "service_account";
      raw: Record<string, unknown>;
    }
  | {
      type: "authorized_user";
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      quotaProjectId?: string;
      raw: Record<string, unknown>;
    }
  | {
      type: "other";
      rawType: string;
      raw: Record<string, unknown>;
    };

export type MintedToken = {
  accessToken: string;
  expiresAt: number;
};

const OAUTH2_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SAFETY_SKEW_MS = 60_000;

export async function loadAdcCredentials(path: string): Promise<AdcCredentials> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type === "service_account") {
    return { type: "service_account", raw: parsed };
  }
  if (type === "authorized_user") {
    const clientId = readString(parsed.client_id);
    const clientSecret = readString(parsed.client_secret);
    const refreshToken = readString(parsed.refresh_token);
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(
        `authorized_user ADC at ${path} missing client_id, client_secret, or refresh_token`,
      );
    }
    return {
      type: "authorized_user",
      clientId,
      clientSecret,
      refreshToken,
      quotaProjectId: readString(parsed.quota_project_id) || undefined,
      raw: parsed,
    };
  }
  return { type: "other", rawType: type, raw: parsed };
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function mintAccessTokenFromAuthorizedUser(
  cred: Extract<AdcCredentials, { type: "authorized_user" }>,
  deps: { fetch?: FetchLike; now?: () => number } = {},
): Promise<MintedToken> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const body = new URLSearchParams({
    client_id: cred.clientId,
    client_secret: cred.clientSecret,
    refresh_token: cred.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetchImpl(OAUTH2_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `authorized_user ADC token refresh failed: ${res.status} ${res.statusText} ${text}`,
    );
  }
  const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
  const accessToken = readString(json.access_token);
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  if (!accessToken) {
    throw new Error("authorized_user ADC token refresh response missing access_token");
  }
  return {
    accessToken,
    expiresAt: now() + expiresIn * 1000 - SAFETY_SKEW_MS,
  };
}

type CacheKey = string;
const tokenCache = new Map<CacheKey, MintedToken>();

export function clearAdcTokenCache(): void {
  tokenCache.clear();
}

export async function getAuthorizedUserAccessToken(
  cred: Extract<AdcCredentials, { type: "authorized_user" }>,
  deps: { fetch?: FetchLike; now?: () => number } = {},
): Promise<string> {
  const now = deps.now ?? Date.now;
  const key = `${cred.clientId}:${cred.refreshToken}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > now()) {
    return cached.accessToken;
  }
  const minted = await mintAccessTokenFromAuthorizedUser(cred, deps);
  tokenCache.set(key, minted);
  return minted.accessToken;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
