import { resolveExpiresAtMsFromDurationSeconds } from "openclaw/plugin-sdk/number-runtime";
import {
  createProviderHttpError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import {
  createOAuthRefreshError,
  createOAuthRefreshResponseError,
  readOAuthRefreshErrorReason,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  MSTEAMS_DEFAULT_DELEGATED_SCOPES,
  MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS,
  MSTEAMS_OAUTH_REDIRECT_URI,
  buildMSTeamsTokenEndpoint,
  type MSTeamsDelegatedTokens,
} from "./oauth.shared.js";

/** Five-minute buffer subtracted from token expiry to avoid edge-case clock drift. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

type MSTeamsTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expiresAt: number;
  scope?: string;
};

function parseMSTeamsTokenResponse(data: unknown, failureLabel: string): MSTeamsTokenResponse {
  if (!isRecord(data)) {
    throw new Error(`MSTeams ${failureLabel} failed: invalid token response fields`);
  }
  const expiresAt = resolveExpiresAtMsFromDurationSeconds(data.expires_in, {
    bufferMs: EXPIRY_BUFFER_MS,
  });
  if (
    typeof data.access_token !== "string" ||
    !data.access_token ||
    expiresAt === undefined ||
    (data.refresh_token !== undefined &&
      (typeof data.refresh_token !== "string" || !data.refresh_token)) ||
    (data.scope !== undefined && typeof data.scope !== "string")
  ) {
    throw new Error(`MSTeams ${failureLabel} failed: invalid token response fields`);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiresAt,
    scope: data.scope,
  };
}

async function fetchMSTeamsTokens(params: {
  tokenUrl: string;
  body: URLSearchParams;
  auditContext: string;
  failureLabel: string;
  refresh: boolean;
}): Promise<MSTeamsTokenResponse> {
  let dispatched = false;
  const { response, release } = await fetchWithSsrFGuard({
    beforeRequest: () => {
      dispatched = true;
    },
    url: params.tokenUrl,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json",
      },
      body: params.body,
      signal: AbortSignal.timeout(MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS),
    },
    auditContext: params.auditContext,
  }).catch((cause: unknown) => {
    if (!params.refresh) {
      throw cause;
    }
    throw createOAuthRefreshError(
      "MSTeams refresh transport failed",
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
    if (!response.ok && !params.refresh) {
      throw await createProviderHttpError(response, `MSTeams ${params.failureLabel} failed`);
    }
    let data: unknown;
    try {
      data = await readProviderJsonResponse<unknown>(
        response,
        `MSTeams ${params.failureLabel} failed`,
      );
    } catch (cause) {
      if (!params.refresh) {
        throw cause;
      }
      // Microsoft documents the refresh grant as reusable: an HTML error page or unreadable body is
      // no rejection, so status alone decides, and a lost success body equals a lost response.
      if (!response.ok) {
        throw createOAuthRefreshResponseError(
          "MSTeams token refresh",
          response.status,
          undefined,
          "documented-reusable-grant",
        );
      }
      throw createOAuthRefreshError(
        "MSTeams refresh response could not be read",
        {
          version: 1,
          phase: "token-response",
          outcome: "unchanged",
          recovery: { kind: "later", evidence: "documented-reusable-grant" },
        },
        { cause },
      );
    }
    if (params.refresh && (!response.ok || readOAuthRefreshErrorReason(data))) {
      throw createOAuthRefreshResponseError(
        "MSTeams token refresh",
        response.status,
        data,
        "documented-reusable-grant",
      );
    }
    try {
      return parseMSTeamsTokenResponse(data, params.failureLabel);
    } catch (cause) {
      if (!params.refresh) {
        throw cause;
      }
      throw createOAuthRefreshError(
        "MSTeams refresh response fields are invalid",
        {
          version: 1,
          phase: "after-token-response",
          outcome: "unknown",
          status: response.status,
        },
        { cause },
      );
    }
  } finally {
    await release();
  }
}

async function requestMSTeamsDelegatedTokens(params: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scopes?: readonly string[];
  grantType: string;
  values: Record<string, string>;
  auditContext: string;
  failureLabel: string;
  resolveRefreshToken: (data: MSTeamsTokenResponse) => string;
}): Promise<MSTeamsDelegatedTokens> {
  const scopes = params.scopes ?? MSTEAMS_DEFAULT_DELEGATED_SCOPES;
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: params.grantType,
    scope: scopes.join(" "),
    ...params.values,
  });
  const data = await fetchMSTeamsTokens({
    tokenUrl: buildMSTeamsTokenEndpoint(params.tenantId),
    body,
    auditContext: params.auditContext,
    failureLabel: params.failureLabel,
    refresh: params.grantType === "refresh_token",
  });

  return {
    accessToken: data.access_token,
    refreshToken: params.resolveRefreshToken(data),
    expiresAt: data.expiresAt,
    scopes: data.scope ? data.scope.split(" ") : [...scopes],
  };
}

export async function exchangeMSTeamsCodeForTokens(params: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
}): Promise<MSTeamsDelegatedTokens> {
  return await requestMSTeamsDelegatedTokens({
    tenantId: params.tenantId,
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    grantType: "authorization_code",
    values: {
      code: params.code,
      redirect_uri: MSTEAMS_OAUTH_REDIRECT_URI,
      code_verifier: params.verifier,
    },
    auditContext: "msteams-oauth-token-exchange",
    failureLabel: "token exchange",
    resolveRefreshToken: (data) => {
      if (!data.refresh_token) {
        throw new Error("No refresh token received from Azure AD. Please try again.");
      }
      return data.refresh_token;
    },
  });
}

export async function refreshMSTeamsDelegatedTokens(params: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scopes?: readonly string[];
}): Promise<MSTeamsDelegatedTokens> {
  return await requestMSTeamsDelegatedTokens({
    tenantId: params.tenantId,
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    grantType: "refresh_token",
    scopes: params.scopes,
    values: {
      refresh_token: params.refreshToken,
    },
    auditContext: "msteams-oauth-token-refresh",
    failureLabel: "token refresh",
    resolveRefreshToken: (data) => data.refresh_token ?? params.refreshToken,
  });
}
