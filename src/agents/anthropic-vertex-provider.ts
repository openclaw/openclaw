import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";

const ANTHROPIC_VERTEX_DEFAULT_REGION = "global";
const ANTHROPIC_VERTEX_REGION_RE = /^[a-z0-9-]+$/;
const GCLOUD_DEFAULT_ADC_PATH = join(
  homedir(),
  ".config",
  "gcloud",
  "application_default_credentials.json",
);

type AdcProjectFile = {
  project_id?: unknown;
  quota_project_id?: unknown;
};

export function resolveAnthropicVertexProjectId(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    normalizeOptionalSecretInput(env.ANTHROPIC_VERTEX_PROJECT_ID) ||
    normalizeOptionalSecretInput(env.GOOGLE_CLOUD_PROJECT) ||
    normalizeOptionalSecretInput(env.GOOGLE_CLOUD_PROJECT_ID) ||
    resolveAnthropicVertexProjectIdFromAdc(env)
  );
}

export function resolveAnthropicVertexRegion(env: NodeJS.ProcessEnv = process.env): string {
  const region =
    normalizeOptionalSecretInput(env.GOOGLE_CLOUD_LOCATION) ||
    normalizeOptionalSecretInput(env.CLOUD_ML_REGION);

  return region && ANTHROPIC_VERTEX_REGION_RE.test(region)
    ? region
    : ANTHROPIC_VERTEX_DEFAULT_REGION;
}

export function resolveAnthropicVertexRegionFromBaseUrl(baseUrl?: string): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    if (host === "aiplatform.googleapis.com") {
      return "global";
    }
    const match = /^([a-z0-9-]+)-aiplatform\.googleapis\.com$/.exec(host);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function resolveAnthropicVertexClientRegion(params?: {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return (
    resolveAnthropicVertexRegionFromBaseUrl(params?.baseUrl) ||
    resolveAnthropicVertexRegion(params?.env)
  );
}

function hasAnthropicVertexMetadataServerAdc(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicitMetadataOptIn = normalizeOptionalSecretInput(env.ANTHROPIC_VERTEX_USE_GCP_METADATA);
  return explicitMetadataOptIn === "1" || explicitMetadataOptIn?.toLowerCase() === "true";
}

function resolveAnthropicVertexDefaultAdcPath(env: NodeJS.ProcessEnv = process.env): string {
  return platform() === "win32"
    ? join(
        env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
        "gcloud",
        "application_default_credentials.json",
      )
    : GCLOUD_DEFAULT_ADC_PATH;
}

function resolveAnthropicVertexAdcCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicitCredentialsPath = normalizeOptionalSecretInput(env.GOOGLE_APPLICATION_CREDENTIALS);
  if (explicitCredentialsPath) {
    return existsSync(explicitCredentialsPath) ? explicitCredentialsPath : undefined;
  }

  const defaultAdcPath = resolveAnthropicVertexDefaultAdcPath(env);
  return existsSync(defaultAdcPath) ? defaultAdcPath : undefined;
}

function resolveAnthropicVertexProjectIdFromAdc(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const credentialsPath = resolveAnthropicVertexAdcCredentialsPath(env);
  if (!credentialsPath) {
    return undefined;
  }

  try {
    const raw = JSON.parse(readFileSync(credentialsPath, "utf8"));
    // Guard against ADC files containing literal null or non-object values.
    // JSON.parse("null") returns null, which would crash on property access
    // in the google-auth import chain with "Cannot convert undefined or null
    // to object". See issue #32245.
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return undefined;
    }
    const parsed = raw as AdcProjectFile;
    return (
      normalizeOptionalSecretInput(parsed.project_id) ||
      normalizeOptionalSecretInput(parsed.quota_project_id)
    );
  } catch {
    return undefined;
  }
}

export function hasAnthropicVertexCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    hasAnthropicVertexMetadataServerAdc(env) ||
    resolveAnthropicVertexAdcCredentialsPath(env) !== undefined
  );
}

export function hasAnthropicVertexAvailableAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasAnthropicVertexCredentials(env);
}
