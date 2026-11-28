// Synchronous Vertex discovery facts do not load token exchange or transport helpers.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GoogleAuthOptions } from "google-auth-library";
import { readSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

export function isGoogleVertexCredentialsMarker(
  apiKey: string | undefined,
): apiKey is undefined | typeof GCP_VERTEX_CREDENTIALS_MARKER {
  return apiKey === undefined || apiKey === GCP_VERTEX_CREDENTIALS_MARKER;
}

function hasGoogleVertexProjectEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    normalizeOptionalString(env.GOOGLE_CLOUD_PROJECT) ||
    normalizeOptionalString(env.GCLOUD_PROJECT),
  );
}

function hasGoogleVertexLocationEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(normalizeOptionalString(env.GOOGLE_CLOUD_LOCATION));
}

export function resolveGoogleApplicationCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = normalizeOptionalString(env.GOOGLE_APPLICATION_CREDENTIALS);
  if (explicit) {
    return existsSync(explicit) ? explicit : undefined;
  }
  const cloudSdkDir = normalizeOptionalString(env.CLOUDSDK_CONFIG);
  if (cloudSdkDir) {
    const cloudSdkFallback = path.join(cloudSdkDir, "application_default_credentials.json");
    return existsSync(cloudSdkFallback) ? cloudSdkFallback : undefined;
  }
  const homeDir = normalizeOptionalString(env.HOME) ?? os.homedir();
  const homeFallback = path.join(
    homeDir,
    ".config",
    "gcloud",
    "application_default_credentials.json",
  );
  if (existsSync(homeFallback)) {
    return homeFallback;
  }
  const appDataDir = normalizeOptionalString(env.APPDATA);
  if (!appDataDir) {
    return undefined;
  }
  const appDataFallback = path.join(appDataDir, "gcloud", "application_default_credentials.json");
  return existsSync(appDataFallback) ? appDataFallback : undefined;
}

export type GoogleAdcConfig = NonNullable<GoogleAuthOptions["credentials"]>;
const GOOGLE_VERTEX_ADC_FILE_MAX_BYTES = 1024 * 1024;

export function readGoogleAdcCredentials(adcPath: string): GoogleAdcConfig {
  const text = readSecretFileSync(adcPath, "Google Vertex ADC credentials", {
    maxBytes: GOOGLE_VERTEX_ADC_FILE_MAX_BYTES,
    rejectHardlinks: false,
  });
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Google Vertex ADC credentials must be a JSON object: ${adcPath}`);
  }
  // SAFETY: Discovery needs an object; the token/auth owner interprets its ADC fields.
  return parsed as GoogleAdcConfig;
}

function readGoogleAdcCredentialsTypeSync(credentialsPath: string): string | undefined {
  try {
    const type = readGoogleAdcCredentials(credentialsPath).type;
    return typeof type === "string" ? type : undefined;
  } catch {
    return undefined;
  }
}

// File-backed ADC includes authorized users, workload identity, and service accounts.
// On GCE VMs without a local ADC file, google-auth-library uses the metadata server.
function isGceMetadataEnvironmentSync(env: NodeJS.ProcessEnv = process.env): boolean {
  if (
    normalizeOptionalString(env.GCE_METADATA_HOST) ||
    normalizeOptionalString(env.GCE_METADATA_IP)
  ) {
    return true;
  }
  try {
    const productName = readFileSync("/sys/class/dmi/id/product_name", "utf8").trim();
    if (productName === "Google Compute Engine") {
      return true;
    }
  } catch {
    // Non-Linux or restricted sysfs.
  }
  try {
    const sysVendor = readFileSync("/sys/class/dmi/id/sys_vendor", "utf8").trim();
    if (sysVendor === "Google") {
      return true;
    }
  } catch {
    // Non-Linux or restricted sysfs.
  }
  return false;
}

function hasGoogleVertexAdcSync(env: NodeJS.ProcessEnv = process.env): boolean {
  const credentialsPath = resolveGoogleApplicationCredentialsPath(env);
  if (credentialsPath) {
    const type = readGoogleAdcCredentialsTypeSync(credentialsPath);
    return type === "authorized_user" || type === "external_account" || type === "service_account";
  }
  if (normalizeOptionalString(env.GOOGLE_APPLICATION_CREDENTIALS)) {
    return false;
  }
  return isGceMetadataEnvironmentSync(env);
}

export function resolveGoogleVertexConfigApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return hasGoogleVertexProjectEnv(env) &&
    hasGoogleVertexLocationEnv(env) &&
    hasGoogleVertexAdcSync(env)
    ? GCP_VERTEX_CREDENTIALS_MARKER
    : undefined;
}
