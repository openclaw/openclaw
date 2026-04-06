import { resolveProviderEndpoint } from "openclaw/plugin-sdk/provider-http";

const GOOGLE_VERTEX_DEFAULT_REGION = "us-central1";
const GOOGLE_VERTEX_REGION_RE = /^[a-z0-9-]+$/;

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function resolveGoogleVertexRegion(env: NodeJS.ProcessEnv = process.env): string {
  const region =
    normalizeOptionalString(env.GOOGLE_CLOUD_LOCATION) ||
    normalizeOptionalString(env.CLOUD_ML_REGION);

  return region && GOOGLE_VERTEX_REGION_RE.test(region) ? region : GOOGLE_VERTEX_DEFAULT_REGION;
}

export function resolveGoogleVertexProjectId(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    normalizeOptionalString(env.GOOGLE_CLOUD_PROJECT) ||
    normalizeOptionalString(env.GOOGLE_CLOUD_PROJECT_ID)
  );
}

export function resolveGoogleVertexRegionFromBaseUrl(baseUrl?: string): string | undefined {
  const endpoint = resolveProviderEndpoint(baseUrl);
  return endpoint.endpointClass === "google-vertex" ? endpoint.googleVertexRegion : undefined;
}

/**
 * Build the full Vertex AI base URL for Google Gemini models.
 *
 * Format: https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google
 *
 * The transport layer appends `/models/{model}:streamGenerateContent?alt=sse`.
 */
export function buildGoogleVertexBaseUrl(params: { region: string; projectId: string }): string {
  const { region, projectId } = params;
  const host =
    region.toLowerCase() === "global"
      ? "https://aiplatform.googleapis.com"
      : `https://${region}-aiplatform.googleapis.com`;
  return `${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/publishers/google`;
}
