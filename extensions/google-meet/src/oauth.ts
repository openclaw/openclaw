import {
  MAX_DATE_TIMESTAMP_MS,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationSeconds,
} from "openclaw/plugin-sdk/number-runtime";
import {
  parseOAuthCallbackInput,
  waitForLocalOAuthCallback,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  createOAuthRefreshError,
  createOAuthRefreshResponseError,
  readOAuthRefreshErrorReason,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { readGoogleApiErrorDetail } from "./google-api.js";

const GOOGLE_MEET_REDIRECT_URI = "http://localhost:8085/oauth2callback";
const GOOGLE_MEET_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_MEET_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_MEET_TOKEN_HOST = "oauth2.googleapis.com";
const GOOGLE_MEET_DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const GOOGLE_OAUTH_TOKEN_JSON_MAX_BYTES = 256 * 1024;
const GOOGLE_OAUTH_REQUEST_TIMEOUT_MS = 30_000;
const GOOGLE_MEET_SCOPES = [
  "https://www.googleapis.com/auth/meetings.space.created",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/meetings.space.settings",
  "https://www.googleapis.com/auth/meetings.conference.media.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/drive.meet.readonly",
] as const;

function resolveGoogleMeetTokenExpiresAt(value: unknown): number {
  const now = resolveDateTimestampMs(Date.now());
  if (typeof value === "number" && Number.isFinite(value) && value <= 0) {
    return now;
  }
  return (
    resolveExpiresAtMsFromDurationSeconds(value, { nowMs: now }) ??
    resolveExpiresAtMsFromDurationSeconds(GOOGLE_MEET_DEFAULT_TOKEN_LIFETIME_SECONDS, {
      nowMs: now,
    }) ??
    now
  );
}

export function buildGoogleMeetAuthUrl(params: {
  clientId: string;
  challenge: string;
  state: string;
}): string {
  const search = new URLSearchParams({
    client_id: params.clientId,
    response_type: "code",
    redirect_uri: GOOGLE_MEET_REDIRECT_URI,
    scope: GOOGLE_MEET_SCOPES.join(" "),
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state: params.state,
  });
  return `${GOOGLE_MEET_AUTH_URL}?${search.toString()}`;
}

type GoogleTokenPayload = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

async function executeGoogleTokenRequest(body: URLSearchParams) {
  const refreshing = body.get("grant_type") === "refresh_token";
  let dispatched = false;
  const { response, release } = await fetchWithSsrFGuard({
    beforeRequest: () => {
      dispatched = true;
    },
    url: GOOGLE_MEET_TOKEN_URL,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json",
      },
      body,
    },
    policy: { allowedHostnames: [GOOGLE_MEET_TOKEN_HOST] },
    auditContext: "google-meet.oauth.token",
    timeoutMs: GOOGLE_OAUTH_REQUEST_TIMEOUT_MS,
  }).catch((cause: unknown) => {
    if (!refreshing) {
      throw cause;
    }
    throw createOAuthRefreshError(
      "Google Meet OAuth refresh transport failed",
      dispatched
        ? {
            version: 1,
            phase: "token-response",
            outcome: "unchanged",
            recovery: { kind: "later", evidence: "documented-reusable-grant" },
          }
        : {
            version: 1,
            phase: "before-dispatch",
            outcome: "not-attempted",
            recovery: { kind: "later", evidence: "dispatch-not-started" },
          },
      { cause },
    );
  });
  try {
    if (!response.ok && !refreshing) {
      const detail = await readGoogleApiErrorDetail(response);
      throw new Error(`Google OAuth token request failed (${response.status}): ${detail}`);
    }
    let payload: GoogleTokenPayload;
    try {
      payload = await readProviderJsonResponse<GoogleTokenPayload>(response, "Google OAuth token", {
        maxBytes: GOOGLE_OAUTH_TOKEN_JSON_MAX_BYTES,
      });
    } catch (cause) {
      if (!refreshing) {
        throw cause;
      }
      // Google documents the refresh grant as reusable: an HTML error page or unreadable body is
      // no rejection, so status alone decides, and a lost success body equals a lost response.
      if (!response.ok) {
        throw createOAuthRefreshResponseError(
          "Google Meet OAuth refresh",
          response.status,
          undefined,
          "documented-reusable-grant",
        );
      }
      throw createOAuthRefreshError(
        cause instanceof Error && cause.message.startsWith("Google OAuth token:")
          ? cause.message
          : "Google Meet OAuth refresh response could not be read",
        {
          version: 1,
          phase: "token-response",
          outcome: "unchanged",
          recovery: { kind: "later", evidence: "documented-reusable-grant" },
        },
        { cause },
      );
    }
    if (refreshing && (!response.ok || readOAuthRefreshErrorReason(payload))) {
      throw createOAuthRefreshResponseError(
        "Google Meet OAuth refresh",
        response.status,
        payload,
        "documented-reusable-grant",
      );
    }
    const accessToken =
      typeof payload?.access_token === "string" ? payload.access_token.trim() : undefined;
    if (!accessToken) {
      throw createOAuthRefreshError("Google OAuth token response was missing access_token", {
        version: 1,
        phase: "after-token-response",
        outcome: "unknown",
        status: response.status,
      });
    }
    if (
      refreshing &&
      payload.refresh_token !== undefined &&
      (typeof payload.refresh_token !== "string" || !payload.refresh_token.trim())
    ) {
      throw createOAuthRefreshError("Google Meet OAuth refresh returned an invalid refresh_token", {
        version: 1,
        phase: "after-token-response",
        outcome: "unknown",
        status: response.status,
      });
    }
    return {
      accessToken,
      expiresAt: resolveGoogleMeetTokenExpiresAt(payload.expires_in),
      refreshToken:
        typeof payload.refresh_token === "string"
          ? payload.refresh_token.trim() || undefined
          : undefined,
      scope: typeof payload.scope === "string" ? payload.scope.trim() || undefined : undefined,
      tokenType:
        typeof payload.token_type === "string" ? payload.token_type.trim() || undefined : undefined,
    };
  } finally {
    await release();
  }
}

function tokenRequestBody(values: Record<string, string | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value?.trim()) {
      body.set(key, value);
    }
  }
  return body;
}

export async function exchangeGoogleMeetAuthCode(params: {
  clientId: string;
  clientSecret?: string;
  code: string;
  verifier: string;
}) {
  return await executeGoogleTokenRequest(
    tokenRequestBody({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      grant_type: "authorization_code",
      redirect_uri: GOOGLE_MEET_REDIRECT_URI,
      code_verifier: params.verifier,
    }),
  );
}

export async function refreshGoogleMeetAccessToken(params: {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}) {
  return await executeGoogleTokenRequest(
    tokenRequestBody({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
    }),
  );
}

export function shouldUseCachedGoogleMeetAccessToken(params: {
  accessToken?: string;
  expiresAt?: number;
}): boolean {
  const now = Date.now();
  return Boolean(
    params.accessToken?.trim() &&
    typeof params.expiresAt === "number" &&
    Number.isFinite(params.expiresAt) &&
    params.expiresAt <= MAX_DATE_TIMESTAMP_MS &&
    params.expiresAt > now + 60_000,
  );
}

export async function resolveGoogleMeetAccessToken(params: {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
}): Promise<{ accessToken: string; expiresAt?: number; refreshed: boolean }> {
  if (params.accessToken && shouldUseCachedGoogleMeetAccessToken(params)) {
    return {
      accessToken: params.accessToken.trim(),
      expiresAt: params.expiresAt,
      refreshed: false,
    };
  }
  if (!params.clientId?.trim() || !params.refreshToken?.trim()) {
    throw new Error(
      "Missing Google Meet OAuth credentials. Configure oauth.clientId and oauth.refreshToken, or pass --client-id and --refresh-token.",
    );
  }
  const refreshed = await refreshGoogleMeetAccessToken({
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    refreshToken: params.refreshToken,
  });
  if (refreshed.refreshToken && refreshed.refreshToken !== params.refreshToken) {
    throw new Error(
      "Google Meet refresh-token rotation requires a durable credential owner. Use the configured Google Meet plugin route, or reauthorize and save the replacement in the external credential owner.",
    );
  }
  return {
    accessToken: refreshed.accessToken,
    expiresAt: refreshed.expiresAt,
    refreshed: true,
  };
}

function isLocalCallbackListenerError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("EADDRINUSE") ||
    error.message.includes("port") ||
    error.message.includes("listen")
  );
}

export async function waitForGoogleMeetAuthCode(params: {
  state: string;
  manual: boolean;
  timeoutMs: number;
  authUrl: string;
  promptInput: (message: string) => Promise<string>;
  writeLine: (message: string) => void;
}): Promise<string> {
  async function readManualGoogleMeetAuthCode(): Promise<string> {
    const { state, promptInput } = params;
    const input = await promptInput("Paste the full redirect URL here: ");
    const parsed = parseOAuthCallbackInput(input, {
      missingState: "Missing 'state' parameter. Paste the full redirect URL.",
      invalidInput: "Paste the full redirect URL, not just the code.",
    });
    if ("error" in parsed) {
      throw new Error(parsed.error);
    }
    if (parsed.state !== state) {
      throw new Error("OAuth state mismatch - please try again");
    }
    return parsed.code;
  }
  params.writeLine(`Open this URL in your browser:\n\n${params.authUrl}\n`);
  if (params.manual) {
    return await readManualGoogleMeetAuthCode();
  }
  try {
    const callback = await waitForLocalOAuthCallback({
      expectedState: params.state,
      timeoutMs: params.timeoutMs,
      port: 8085,
      callbackPath: "/oauth2callback",
      redirectUri: GOOGLE_MEET_REDIRECT_URI,
      successTitle: "Google Meet authorization received",
    });
    return callback.code;
  } catch (error) {
    if (!isLocalCallbackListenerError(error)) {
      throw error;
    }
    params.writeLine("Local callback server failed. Switching to manual mode...");
    return await readManualGoogleMeetAuthCode();
  }
}
