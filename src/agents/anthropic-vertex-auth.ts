/**
 * GCP Application Default Credentials (ADC) authentication for Vertex AI.
 *
 * Supports two credential types:
 * - **authorized_user**: OAuth2 refresh_token flow (from `gcloud auth application-default login`)
 * - **service_account**: JWT-signed token exchange (from service account key JSON)
 *
 * Builds on the approach from @sallyom's original anthropic-vertex provider
 * (PR #23985, issues #6937 and #17277), simplified to use zero external
 * dependencies — raw OAuth2/JWT flows via native fetch + Node crypto.
 *
 * @see https://github.com/openclaw/openclaw/pull/23985
 * @see https://github.com/openclaw/openclaw/issues/6937
 * @see https://github.com/openclaw/openclaw/issues/17277
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("anthropic-vertex-auth");

const DEFAULT_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const JWT_LIFETIME_SECONDS = 3600;

// Refresh 60 seconds before expiry to avoid edge cases.
const TOKEN_REFRESH_MARGIN_MS = 60_000;

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let inflightRefresh: Promise<string> | null = null;

export type GcpAuthorizedUserCredentials = {
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
};

export type GcpServiceAccountCredentials = {
  type: "service_account";
  client_email: string;
  private_key: string;
  token_uri: string;
};

export type GcpAdcCredentials = GcpAuthorizedUserCredentials | GcpServiceAccountCredentials;

/**
 * Resolve the path to GCP Application Default Credentials.
 */
export function resolveAdcPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    return env.GOOGLE_APPLICATION_CREDENTIALS.trim();
  }
  return path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json");
}

/**
 * Read and parse ADC credentials from disk.
 * Supports both authorized_user (refresh_token) and service_account (JWT) types.
 */
export function readAdcCredentials(adcPath: string): GcpAdcCredentials {
  const raw = fs.readFileSync(adcPath, "utf8");
  const creds = JSON.parse(raw) as Record<string, unknown>;
  const credType = typeof creds.type === "string" ? creds.type : "";

  if (credType === "service_account") {
    const clientEmail = typeof creds.client_email === "string" ? creds.client_email.trim() : "";
    const privateKey = typeof creds.private_key === "string" ? creds.private_key : "";
    const tokenUri =
      typeof creds.token_uri === "string" ? creds.token_uri.trim() : DEFAULT_TOKEN_ENDPOINT;
    if (!clientEmail) {
      throw new Error(`GCP service account credentials at ${adcPath} missing client_email`);
    }
    if (!privateKey) {
      throw new Error(`GCP service account credentials at ${adcPath} missing private_key`);
    }
    return {
      type: "service_account",
      client_email: clientEmail,
      private_key: privateKey,
      token_uri: tokenUri,
    };
  }

  // Default: authorized_user
  const refreshToken = typeof creds.refresh_token === "string" ? creds.refresh_token : "";
  const clientId = typeof creds.client_id === "string" ? creds.client_id : "";
  const clientSecret = typeof creds.client_secret === "string" ? creds.client_secret : "";
  if (!refreshToken) {
    throw new Error(
      `GCP ADC credentials at ${adcPath} must contain a refresh_token (run: gcloud auth application-default login)`,
    );
  }
  if (!clientId || !clientSecret) {
    throw new Error(`GCP ADC credentials at ${adcPath} missing client_id or client_secret`);
  }
  return {
    type: "authorized_user",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  };
}

/**
 * Check whether GCP ADC credentials are available.
 */
export function hasGcpAdcCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const adcPath = resolveAdcPath(env);
    fs.accessSync(adcPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refresh the OAuth2 access token using GCP ADC credentials.
 * Detects credential type and uses the appropriate flow:
 * - authorized_user: OAuth2 refresh_token exchange
 * - service_account: JWT-signed assertion exchange
 *
 * Returns a valid access token (cached if not expired).
 */
export async function getVertexAccessToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return cachedToken;
  }
  // Deduplicate concurrent refresh requests.
  if (inflightRefresh) {
    return inflightRefresh;
  }
  inflightRefresh = refreshAccessToken(env);
  try {
    return await inflightRefresh;
  } finally {
    inflightRefresh = null;
  }
}

async function refreshAccessToken(env: NodeJS.ProcessEnv): Promise<string> {
  const adcPath = resolveAdcPath(env);
  const creds = readAdcCredentials(adcPath);

  if (creds.type === "service_account") {
    return refreshServiceAccountToken(creds);
  }
  return refreshAuthorizedUserToken(creds);
}

async function refreshAuthorizedUserToken(creds: GcpAuthorizedUserCredentials): Promise<string> {
  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: "refresh_token",
  });

  const res = await fetch(DEFAULT_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown");
    throw new Error(`GCP token refresh failed (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  log.debug(`GCP access token refreshed (authorized_user), expires in ${data.expires_in}s`);
  return cachedToken;
}

async function refreshServiceAccountToken(creds: GcpServiceAccountCredentials): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const signedJwt = buildSignedJwt({
    clientEmail: creds.client_email,
    privateKey: creds.private_key,
    tokenUri: creds.token_uri,
    iat: now,
    exp: now + JWT_LIFETIME_SECONDS,
  });

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: signedJwt,
  });

  const res = await fetch(creds.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown");
    throw new Error(`GCP service account token exchange failed (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  log.debug(`GCP access token refreshed (service_account), expires in ${data.expires_in}s`);
  return cachedToken;
}

// ── JWT construction (zero deps — uses Node crypto) ────────────────────────

function base64UrlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return buf.toString("base64url");
}

/** Build and sign a JWT for the service account OAuth2 assertion flow. */
export function buildSignedJwt(params: {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
  iat: number;
  exp: number;
}): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: params.clientEmail,
      scope: CLOUD_PLATFORM_SCOPE,
      aud: params.tokenUri,
      iat: params.iat,
      exp: params.exp,
    }),
  );

  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput, "utf8"), params.privateKey);

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

/**
 * Resolve the GCP project ID from environment or ADC credentials.
 */
export function resolveVertexProjectId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.ANTHROPIC_VERTEX_PROJECT_ID?.trim() ||
    env.GOOGLE_CLOUD_PROJECT?.trim() ||
    env.GCLOUD_PROJECT?.trim() ||
    undefined
  );
}

/**
 * Resolve the Vertex AI region from environment.
 */
export function resolveVertexRegion(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLOUD_ML_REGION?.trim() || env.GOOGLE_CLOUD_LOCATION?.trim() || "us-east5";
}

/**
 * Build the Vertex AI streamRawPredict URL for a given model.
 * A trailing `#` is appended so that when the Anthropic SDK appends
 * `/v1/messages`, the extra path is absorbed into the URL fragment
 * and stripped by `fetch()` per the WHATWG Fetch spec.
 */
export function buildVertexBaseUrl(params: {
  project: string;
  region: string;
  model: string;
}): string {
  return (
    `https://${params.region}-aiplatform.googleapis.com/v1/projects/${params.project}` +
    `/locations/${params.region}/publishers/anthropic/models/${params.model}:streamRawPredict#`
  );
}

/** Reset cached token (for testing). */
export function resetVertexAuthCacheForTest(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
  inflightRefresh = null;
}
