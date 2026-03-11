/**
 * GCP Application Default Credentials (ADC) authentication for Vertex AI.
 *
 * Builds on the approach from @sallyom's original anthropic-vertex provider
 * (PR #23985, issues #6937 and #17277), simplified to use zero external
 * dependencies — raw OAuth2 refresh_token flow via native fetch instead of
 * `@anthropic-ai/vertex-sdk`.
 *
 * @see https://github.com/openclaw/openclaw/pull/23985
 * @see https://github.com/openclaw/openclaw/issues/6937
 * @see https://github.com/openclaw/openclaw/issues/17277
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("anthropic-vertex-auth");

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// Refresh 60 seconds before expiry to avoid edge cases.
const TOKEN_REFRESH_MARGIN_MS = 60_000;

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let inflightRefresh: Promise<string> | null = null;

export type GcpAdcCredentials = {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  type: string;
};

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
 */
export function readAdcCredentials(adcPath: string): GcpAdcCredentials {
  const raw = fs.readFileSync(adcPath, "utf8");
  const creds = JSON.parse(raw) as Partial<GcpAdcCredentials>;
  if (!creds.refresh_token) {
    throw new Error(
      `GCP ADC credentials at ${adcPath} must contain a refresh_token (run: gcloud auth application-default login)`,
    );
  }
  if (!creds.client_id || !creds.client_secret) {
    throw new Error(`GCP ADC credentials at ${adcPath} missing client_id or client_secret`);
  }
  return creds as GcpAdcCredentials;
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
 * Refresh the OAuth2 access token using GCP ADC refresh_token flow.
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

  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: "refresh_token",
  });

  const res = await fetch(TOKEN_ENDPOINT, {
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
  log.debug(`GCP access token refreshed, expires in ${data.expires_in}s`);
  return cachedToken;
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
