import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
  resolveExpiresAtMsFromDurationSeconds,
} from "openclaw/plugin-sdk/number-runtime";
import {
  createOAuthRefreshError,
  createOAuthRefreshResponseError,
  readOAuthRefreshErrorReason,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
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
  identity: string;
};

type GoogleOauthTokenResponsePayload = {
  access_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
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
type GoogleAuthClient = Promise<{ getAccessToken: () => Promise<string | null | undefined> }>;
let cachedGoogleAuthClient: { identity: string; promise: GoogleAuthClient } | undefined;
const authorizedUserTasks = new Map<string, Promise<string>>();

function isGoogleVertexTokenFresh(expiresAtMsRaw: number): boolean {
  const expiresAtMs = asDateTimestampMs(expiresAtMsRaw);
  const nowMs = asDateTimestampMs(Date.now());
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
  authorizedUserTasks.clear();
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

/** Google documents refresh grants as reusable; the external ADC owner retains custody. */
async function refreshGoogleVertexAuthorizedUserAccessToken(params: {
  credentials: GoogleAuthorizedUserCredentials;
  identity: string;
  assertCurrent: () => void;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  } = params.credentials;
  if (!clientId || !clientSecret || !refreshToken) {
    throw createOAuthRefreshError(
      "Google Vertex authorized_user ADC is missing client_id, client_secret, or refresh_token.",
      { version: 1, phase: "before-dispatch", outcome: "rejected", reason: "invalid_client" },
    );
  }
  params.assertCurrent();
  const cached = cachedGoogleVertexAuthorizedUserToken;
  if (cached?.identity === params.identity && isGoogleVertexTokenFresh(cached.expiresAtMs)) {
    return cached.token;
  }
  const pending = authorizedUserTasks.get(params.identity);
  if (pending) {
    return await pending;
  }
  const task = (async () => {
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
    let dispatched = false;
    let responseFailure: Error | undefined;
    let token: string;
    let expiresAtMs: number | undefined;
    try {
      params.assertCurrent();
      signal?.throwIfAborted();
      dispatched = true;
      const response = await (params.fetchImpl ?? fetch)(GOOGLE_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal,
        redirect: "error",
      });
      const payload = await readGoogleOauthTokenResponsePayload(response, signal);
      if (!response.ok || readOAuthRefreshErrorReason(payload)) {
        responseFailure = createOAuthRefreshResponseError(
          "Google Vertex ADC refresh",
          response.status,
          payload,
          "documented-reusable-grant",
        );
        throw responseFailure;
      }
      token = normalizeOptionalString(payload?.access_token) ?? "";
      if (
        !token ||
        (payload?.token_type !== undefined &&
          (typeof payload.token_type !== "string" || payload.token_type.toLowerCase() !== "bearer"))
      ) {
        throw new Error("Google Vertex ADC token response has invalid access_token or token_type.");
      }
      if (payload?.refresh_token !== undefined && payload.refresh_token !== refreshToken) {
        // We cannot publish success while discarding a rotation we cannot write to gcloud's file.
        throw new Error(
          "Google Vertex ADC returned refresh-token rotation without an owned persistence route; reauthorize with its external ADC owner.",
        );
      }
      if (
        payload?.expires_in !== undefined &&
        (typeof payload.expires_in !== "number" ||
          !Number.isFinite(payload.expires_in) ||
          payload.expires_in <= 0)
      ) {
        throw new Error("Google Vertex ADC token response has invalid expires_in.");
      }
      expiresAtMs = resolveAuthorizedUserTokenExpiresAtMs(payload?.expires_in, Date.now());
      params.assertCurrent();
    } catch (error) {
      if (!dispatched) {
        throw createOAuthRefreshError("Google Vertex ADC refresh did not start.", {
          version: 1,
          phase: "before-dispatch",
          outcome: "not-attempted",
          recovery: { kind: "later", evidence: "dispatch-not-started" },
        });
      }
      if (responseFailure) {
        throw responseFailure;
      }
      // Keep the owner-created size/deadline diagnostic without echoing arbitrary transport text.
      const boundedDiagnostic =
        error instanceof Error &&
        (error.name === "TimeoutError" ||
          error.message.startsWith("Google OAuth token response exceeds "))
          ? error
          : undefined;
      const failure = createOAuthRefreshError(
        boundedDiagnostic?.message ??
          "Google Vertex ADC refresh failed; retry with its externally owned reusable grant.",
        {
          version: 1,
          phase: "token-response",
          outcome: "unchanged",
          recovery: { kind: "later", evidence: "documented-reusable-grant" },
        },
        { cause: error },
      );
      if (boundedDiagnostic?.name === "TimeoutError") {
        failure.name = "TimeoutError";
      }
      throw failure;
    } finally {
      cleanup();
    }
    params.assertCurrent();
    if (expiresAtMs !== undefined) {
      cachedGoogleVertexAuthorizedUserToken = { token, expiresAtMs, identity: params.identity };
    }
    return token;
  })();
  authorizedUserTasks.set(params.identity, task);
  try {
    return await task;
  } finally {
    if (authorizedUserTasks.get(params.identity) === task) {
      authorizedUserTasks.delete(params.identity);
    }
  }
}

async function readGoogleOauthTokenResponsePayload(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<GoogleOauthTokenResponsePayload | undefined> {
  const bytes = await readResponseWithLimit(response, GOOGLE_OAUTH_TOKEN_RESPONSE_MAX_BYTES, {
    signal,
    timeoutMs: GOOGLE_VERTEX_ADC_TOKEN_REFRESH_TIMEOUT_MS,
    onOverflow: ({ maxBytes }) =>
      new Error(`Google OAuth token response exceeds ${maxBytes} bytes`),
  });
  const text = decodeGoogleOauthTokenResponseBody(bytes, response.headers.get("content-encoding"));
  if (!text.trim()) {
    return undefined;
  }
  try {
    const payload: unknown = JSON.parse(text);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function decodeGoogleOauthTokenResponseBody(bytes: Buffer, contentEncoding: string | null): string {
  if (shouldGunzipGoogleOauthTokenResponse(bytes, contentEncoding)) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        gunzipSync(bytes, { maxOutputLength: GOOGLE_OAUTH_TOKEN_RESPONSE_MAX_BYTES }),
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
      // Fetch may already have decompressed bytes while retaining Content-Encoding.
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        throw error;
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
  adcConfig: GoogleAdcConfig | undefined,
  identity: string,
): Promise<string> {
  // Lazy-import + cache so we don't pay the google-auth-library load cost on
  // gateway startup; only when we actually need a non-authorized_user token.
  if (cachedGoogleAuthClient?.identity !== identity) {
    cachedGoogleAuthClient = {
      identity,
      promise: import("google-auth-library").then(
        ({ GoogleAuth }) =>
          new GoogleAuth({
            scopes: [GOOGLE_VERTEX_OAUTH_SCOPE],
            ...(adcConfig ? { credentials: adcConfig } : {}),
            // WIF STS and GCE metadata also need the owner-level deadline below.
            clientOptions: {
              transporterOptions: { timeout: GOOGLE_VERTEX_ADC_TOKEN_REFRESH_TIMEOUT_MS },
            },
          }),
      ),
    };
  }
  const authClient = cachedGoogleAuthClient;
  const auth = await authClient.promise;

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
  const readSource = () => {
    const currentPath = resolveGoogleApplicationCredentialsPath();
    const current = currentPath ? readGoogleAdcCredentials(currentPath) : undefined;
    const stat = currentPath ? statSync(currentPath) : undefined;
    return {
      path: currentPath,
      config: current,
      identity: JSON.stringify([
        resolveStateDir(),
        process.env.GOOGLE_APPLICATION_CREDENTIALS,
        process.env.CLOUDSDK_CONFIG,
        process.env.HOME,
        process.env.APPDATA,
        currentPath ? realpathSync(currentPath) : null,
        stat?.dev,
        stat?.ino,
        stat?.mtimeMs,
        stat?.size,
        current,
      ]),
    };
  };
  const selected = readSource();
  const adcPath = selected.path;
  const adcConfig = selected.config;
  const identity = createHash("sha256").update(selected.identity).digest("hex");
  const assertCurrent = () => {
    if (readSource().identity !== selected.identity) {
      throw new Error(
        "Google Vertex ADC input changed during token resolution; retry with its current owner.",
      );
    }
  };
  const userAdc = adcConfig ? resolveGoogleAuthorizedUserCredentials(adcConfig) : undefined;
  // Google auth owns metadata, federation, and service-account ADC variants.
  const token =
    userAdc && adcPath
      ? await refreshGoogleVertexAuthorizedUserAccessToken({
          credentials: userAdc,
          fetchImpl,
          identity,
          assertCurrent,
        })
      : await resolveGoogleVertexAccessTokenViaGoogleAuth(adcConfig, identity);
  assertCurrent();
  // Google auth gives the explicit billing project precedence over ADC metadata.
  const quotaProject =
    normalizeOptionalString(process.env.GOOGLE_CLOUD_QUOTA_PROJECT) ??
    normalizeOptionalString((adcConfig as Record<string, unknown> | undefined)?.quota_project_id);
  return {
    Authorization: `Bearer ${token}`,
    ...(quotaProject ? { "x-goog-user-project": quotaProject } : {}),
  };
}
