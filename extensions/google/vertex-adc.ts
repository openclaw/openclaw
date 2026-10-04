import { gunzipSync } from "node:zlib";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
  resolveExpiresAtMsFromDurationSeconds,
} from "openclaw/plugin-sdk/number-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  readGoogleAdcCredentials,
  resolveGoogleApplicationCredentialsPath,
  type GoogleAdcConfig,
} from "./vertex-adc-config.js";

type GoogleAuthorizedUserCredentials = {
  type: "authorized_user";
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
};

type GoogleVertexAuthorizedUserToken = {
  token: string;
  expiresAtMs: number;
  credentialsPath: string;
  refreshToken: string;
};

type GoogleOauthTokenResponsePayload = {
  access_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
};

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_VERTEX_OAUTH_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const GOOGLE_VERTEX_ADC_TOKEN_REFRESH_TIMEOUT_MS = 30_000;
// Hold tokens slightly less long than reported expiry (Google's recommendation
// is a 60s buffer) so we don't ship a request that's already revoked when it
// leaves the gateway.
const GOOGLE_VERTEX_TOKEN_EXPIRY_BUFFER_MS = 60_000;
const GOOGLE_VERTEX_DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const GOOGLE_OAUTH_TOKEN_RESPONSE_MAX_BYTES = 1024 * 1024;
const VERTEX_ADC_TEST_API_KEY = Symbol.for("openclaw.google.vertexAdcTestApi");

let cachedGoogleVertexAuthorizedUserToken: GoogleVertexAuthorizedUserToken | undefined;
let cachedGoogleAuthClient:
  | Promise<{ getAccessToken: () => Promise<string | null | undefined> }>
  | undefined;

function isGoogleVertexTokenFresh(expiresAtMsRaw: number, nowRaw = Date.now()): boolean {
  const expiresAtMs = asDateTimestampMs(expiresAtMsRaw);
  const nowMs = asDateTimestampMs(nowRaw);
  if (expiresAtMs === undefined || nowMs === undefined) {
    return false;
  }
  const minFreshExpiresAtMs = resolveExpiresAtMsFromDurationMs(
    GOOGLE_VERTEX_TOKEN_EXPIRY_BUFFER_MS,
    { nowMs },
  );
  return minFreshExpiresAtMs !== undefined && expiresAtMs > minFreshExpiresAtMs;
}

function resolveAuthorizedUserTokenExpiresAtMs(value: unknown, nowRaw: number): number | undefined {
  const nowMs = asDateTimestampMs(nowRaw);
  if (nowMs === undefined) {
    return undefined;
  }
  const lifetimeSeconds =
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(1, value)
      : GOOGLE_VERTEX_DEFAULT_TOKEN_LIFETIME_SECONDS;
  return resolveExpiresAtMsFromDurationSeconds(lifetimeSeconds, { nowMs }) ?? nowMs;
}

function resetGoogleVertexAuthorizedUserTokenCacheForTest(): void {
  cachedGoogleVertexAuthorizedUserToken = undefined;
  cachedGoogleAuthClient = undefined;
}

if (process.env.VITEST) {
  (globalThis as Record<PropertyKey, unknown>)[VERTEX_ADC_TEST_API_KEY] = {
    reset: resetGoogleVertexAuthorizedUserTokenCacheForTest,
  };
}

function resolveGoogleAuthorizedUserCredentials(
  adcConfig: GoogleAdcConfig,
): GoogleAuthorizedUserCredentials | undefined {
  const record = adcConfig as Record<string, unknown>;
  if (record.type !== "authorized_user") {
    return undefined;
  }
  return {
    type: "authorized_user",
    client_id: normalizeOptionalString(record.client_id),
    client_secret: normalizeOptionalString(record.client_secret),
    refresh_token: normalizeOptionalString(record.refresh_token),
  };
}

async function refreshGoogleVertexAuthorizedUserAccessToken(params: {
  credentialsPath: string;
  credentials: GoogleAuthorizedUserCredentials;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  } = params.credentials;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google Vertex authorized_user ADC is missing client_id, client_secret, or refresh_token.",
    );
  }

  const cached = cachedGoogleVertexAuthorizedUserToken;
  if (
    cached?.credentialsPath === params.credentialsPath &&
    cached.refreshToken === refreshToken &&
    isGoogleVertexTokenFresh(cached.expiresAtMs)
  ) {
    return cached.token;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs: GOOGLE_VERTEX_ADC_TOKEN_REFRESH_TIMEOUT_MS,
    operation: "google-vertex-adc-token-refresh",
    url: GOOGLE_OAUTH_TOKEN_URL,
  });
  let response: Response;
  let payload: GoogleOauthTokenResponsePayload | undefined;
  try {
    response = await (params.fetchImpl ?? fetch)(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal,
    });
    // Keep the request deadline active through body consumption. Fetch resolves
    // at headers, so cleanup here would leave a stalled token body unbounded.
    payload = await readGoogleOauthTokenResponsePayload(response);
  } finally {
    cleanup();
  }
  if (!response.ok) {
    const description = normalizeOptionalString(payload?.error_description);
    const code = normalizeOptionalString(payload?.error);
    throw new Error(
      `Google Vertex ADC token refresh failed: ${response.status}${code ? ` ${code}` : ""}${description ? ` (${description})` : ""}`,
    );
  }
  if (!payload) {
    throw new Error("Google Vertex ADC token refresh response could not be parsed as JSON.");
  }
  const token = normalizeOptionalString(payload?.access_token);
  if (!token) {
    throw new Error("Google Vertex ADC token refresh response did not include an access_token.");
  }
  const nowMs = Date.now();
  const expiresAtMs = resolveAuthorizedUserTokenExpiresAtMs(payload?.expires_in, nowMs);
  if (expiresAtMs !== undefined) {
    cachedGoogleVertexAuthorizedUserToken = {
      token,
      expiresAtMs,
      credentialsPath: params.credentialsPath,
      refreshToken,
    };
  }
  return token;
}

async function readGoogleOauthTokenResponsePayload(
  response: Response,
): Promise<GoogleOauthTokenResponsePayload | undefined> {
  const bytes = await readResponseWithLimit(response, GOOGLE_OAUTH_TOKEN_RESPONSE_MAX_BYTES, {
    onOverflow: ({ maxBytes }) =>
      new Error(`Google OAuth token response exceeds ${maxBytes} bytes`),
  });
  const text = decodeGoogleOauthTokenResponseBody(bytes, response.headers.get("content-encoding"));
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text) as GoogleOauthTokenResponsePayload;
  } catch {
    return undefined;
  }
}

function decodeGoogleOauthTokenResponseBody(bytes: Buffer, contentEncoding: string | null): string {
  if (shouldGunzipGoogleOauthTokenResponse(bytes, contentEncoding)) {
    try {
      return gunzipSync(bytes, { maxOutputLength: GOOGLE_OAUTH_TOKEN_RESPONSE_MAX_BYTES }).toString(
        "utf8",
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ERR_BUFFER_TOO_LARGE"
      ) {
        throw new Error(
          `Google OAuth token response exceeds ${GOOGLE_OAUTH_TOKEN_RESPONSE_MAX_BYTES} decompressed bytes`,
          { cause: error },
        );
      }
      return bytes.toString("utf8");
    }
  }
  return bytes.toString("utf8");
}

function shouldGunzipGoogleOauthTokenResponse(
  bytes: Buffer,
  contentEncoding: string | null,
): boolean {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return true;
  }
  return (contentEncoding ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .includes("gzip");
}

async function resolveGoogleVertexAccessTokenViaGoogleAuth(
  adcConfig?: GoogleAdcConfig,
): Promise<string> {
  // Lazy-import + cache so we don't pay the google-auth-library load cost on
  // gateway startup; only when we actually need a non-authorized_user token.
  if (!cachedGoogleAuthClient) {
    cachedGoogleAuthClient = import("google-auth-library").then(
      ({ GoogleAuth }) =>
        new GoogleAuth({
          scopes: [GOOGLE_VERTEX_OAUTH_SCOPE],
          ...(adcConfig ? { credentials: adcConfig } : {}),
          // WIF STS and GCE metadata also need the owner-level deadline below.
          clientOptions: {
            transporterOptions: { timeout: GOOGLE_VERTEX_ADC_TOKEN_REFRESH_TIMEOUT_MS },
          },
        }),
    );
  }
  const authClient = cachedGoogleAuthClient;
  const auth = await authClient;

  // Some google-auth-library ADC implementations bypass the configured Gaxios
  // transporter, so this owner-level deadline also bounds STS and metadata paths.
  let token: string | null | undefined;
  try {
    token = await withTimeout(auth.getAccessToken(), GOOGLE_VERTEX_ADC_TOKEN_REFRESH_TIMEOUT_MS, {
      createError: () => new DOMException("request timed out", "TimeoutError"),
    });
  } catch (error) {
    // The dependency coalesces in-flight refreshes. Drop only this timed-out
    // client so a recovered identity endpoint gets a fresh attempt next time.
    if (
      error instanceof DOMException &&
      error.name === "TimeoutError" &&
      cachedGoogleAuthClient === authClient
    ) {
      cachedGoogleAuthClient = undefined;
    }
    throw error;
  }
  const normalized = normalizeOptionalString(token);
  if (!normalized) {
    throw new Error(
      "Google Vertex ADC fallback (google-auth-library) did not return an access token. " +
        "Verify the GKE Workload Identity binding (KSA \u2192 GSA), `GOOGLE_APPLICATION_CREDENTIALS`, " +
        "or other ADC source is reachable from this pod.",
    );
  }
  return normalized;
}

export async function resolveGoogleVertexAuthorizedUserHeaders(
  fetchImpl?: typeof fetch,
): Promise<Record<string, string>> {
  const adcPath = resolveGoogleApplicationCredentialsPath();
  const adcConfig = adcPath ? readGoogleAdcCredentials(adcPath) : undefined;
  const userAdc = adcConfig ? resolveGoogleAuthorizedUserCredentials(adcConfig) : undefined;
  // Google auth owns metadata, federation, and service-account ADC variants.
  const token =
    userAdc && adcPath
      ? await refreshGoogleVertexAuthorizedUserAccessToken({
          credentialsPath: adcPath,
          credentials: userAdc,
          fetchImpl,
        })
      : await resolveGoogleVertexAccessTokenViaGoogleAuth(adcConfig);
  // Google auth gives the explicit billing project precedence over ADC metadata.
  const quotaProject =
    normalizeOptionalString(process.env.GOOGLE_CLOUD_QUOTA_PROJECT) ??
    normalizeOptionalString((adcConfig as Record<string, unknown> | undefined)?.quota_project_id);
  return {
    Authorization: `Bearer ${token}`,
    ...(quotaProject ? { "x-goog-user-project": quotaProject } : {}),
  };
}
