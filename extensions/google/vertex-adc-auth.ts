import { getAuthorizedUserAccessToken, loadAdcCredentials } from "./adc-credentials.js";

const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

export type VertexAuthResolution =
  | { kind: "bearer"; headers: Record<string, string> }
  | { kind: "fallback" };

/**
 * Resolve auth headers for the google-vertex chat path when the upstream
 * apiKey is the synthetic ADC marker. Only `authorized_user` ADC files are
 * exchanged here (the @google/genai SDK can't handle them — see #74628).
 *
 * For service_account or unknown ADC shapes we return `fallback` so the
 * caller can keep its existing behavior (current main forwards the marker
 * through `parseGeminiAuth`, which is broken for non-API-key creds but is
 * preserved here to avoid a wider refactor).
 */
export async function resolveGoogleVertexAuthHeaders(
  apiKey: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VertexAuthResolution> {
  if (apiKey !== GCP_VERTEX_CREDENTIALS_MARKER) {
    return { kind: "fallback" };
  }
  const credPath = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!credPath) {
    return { kind: "fallback" };
  }
  const cred = await loadAdcCredentials(credPath).catch(() => null);
  if (!cred || cred.type !== "authorized_user") {
    return { kind: "fallback" };
  }
  const token = await getAuthorizedUserAccessToken(cred);
  return {
    kind: "bearer",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
}
