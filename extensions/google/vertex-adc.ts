import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveGoogleVertexAdcCredentialsPath } from "./vertex-region.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const SERVICE_ACCOUNT_TOKEN_TTL_SECONDS = 3600;

type AdcAuthorizedUser = {
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
  quota_project_id?: string;
  project_id?: string;
};

type AdcServiceAccount = {
  type: "service_account";
  client_email: string;
  private_key: string;
  project_id?: string;
};

type AdcFile = AdcAuthorizedUser | AdcServiceAccount | { type: string; project_id?: string };

export type GoogleVertexAccessToken = {
  accessToken: string;
  projectId: string | undefined;
  expiresAt: number;
};

let cachedToken: GoogleVertexAccessToken | null = null;

function isAdcAuthorizedUser(adc: AdcFile): adc is AdcAuthorizedUser {
  return (
    adc.type === "authorized_user" &&
    typeof (adc as AdcAuthorizedUser).client_id === "string" &&
    typeof (adc as AdcAuthorizedUser).client_secret === "string" &&
    typeof (adc as AdcAuthorizedUser).refresh_token === "string"
  );
}

function isAdcServiceAccount(adc: AdcFile): adc is AdcServiceAccount {
  return (
    adc.type === "service_account" &&
    typeof (adc as AdcServiceAccount).client_email === "string" &&
    typeof (adc as AdcServiceAccount).private_key === "string"
  );
}

function readAdc(env: NodeJS.ProcessEnv): { adc: AdcFile; path: string } | undefined {
  const path = resolveGoogleVertexAdcCredentialsPath(env);
  try {
    return { adc: JSON.parse(readFileSync(path, "utf8")) as AdcFile, path };
  } catch {
    return undefined;
  }
}

async function refreshAuthorizedUserToken(adc: AdcAuthorizedUser): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: adc.client_id,
      client_secret: adc.client_secret,
      refresh_token: adc.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Google ADC token refresh failed (${response.status}): ${text}`);
  }
  return (await response.json()) as { access_token: string; expires_in: number };
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signServiceAccountAssertion(adc: AdcServiceAccount): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64UrlEncode(
    JSON.stringify({
      iss: adc.client_email,
      scope: CLOUD_PLATFORM_SCOPE,
      aud: TOKEN_URL,
      exp: now + SERVICE_ACCOUNT_TOKEN_TTL_SECONDS,
      iat: now,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(adc.private_key);
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

async function mintServiceAccountToken(adc: AdcServiceAccount): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const assertion = signServiceAccountAssertion(adc);
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Google service-account token exchange failed (${response.status}): ${text}`);
  }
  return (await response.json()) as { access_token: string; expires_in: number };
}

function resolveAdcProjectId(adc: AdcFile, env: NodeJS.ProcessEnv): string | undefined {
  const explicit =
    env.GOOGLE_CLOUD_PROJECT?.trim() || env.GOOGLE_CLOUD_PROJECT_ID?.trim() || undefined;
  if (explicit) {
    return explicit;
  }
  if ("project_id" in adc && typeof adc.project_id === "string" && adc.project_id.trim()) {
    return adc.project_id.trim();
  }
  if ("quota_project_id" in adc) {
    const quota = adc.quota_project_id;
    if (typeof quota === "string" && quota.trim()) {
      return quota.trim();
    }
  }
  return undefined;
}

export async function resolveGoogleVertexAdcToken(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GoogleVertexAccessToken | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken;
  }

  const found = readAdc(env);
  if (!found) {
    return null;
  }
  const { adc, path } = found;
  const projectId = resolveAdcProjectId(adc, env);

  if (isAdcAuthorizedUser(adc)) {
    const result = await refreshAuthorizedUserToken(adc);
    cachedToken = {
      accessToken: result.access_token,
      projectId,
      expiresAt: Date.now() + result.expires_in * 1000,
    };
    return cachedToken;
  }

  if (isAdcServiceAccount(adc)) {
    const result = await mintServiceAccountToken(adc);
    cachedToken = {
      accessToken: result.access_token,
      projectId,
      expiresAt: Date.now() + result.expires_in * 1000,
    };
    return cachedToken;
  }

  throw new Error(
    `Google Vertex AI: unsupported ADC type "${adc.type}" at ${path}. ` +
      'Run "gcloud auth application-default login" or set GOOGLE_APPLICATION_CREDENTIALS ' +
      "to an authorized_user or service_account JSON.",
  );
}

export function clearGoogleVertexAdcTokenCache(): void {
  cachedToken = null;
}
