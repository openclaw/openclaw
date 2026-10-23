import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { matchesNoProxy, resolveEnvHttpProxyAgentOptions } from "openclaw/plugin-sdk/fetch-runtime";
import {
  positiveSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromDurationSeconds,
  resolveExpiresAtMsFromEpochSeconds,
} from "openclaw/plugin-sdk/number-runtime";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildOauthProviderAuthResult,
  toFormUrlEncoded,
  type OAuthCredential,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import {
  createOAuthRefreshError,
  createOAuthRefreshResponseError,
  readOAuthRefreshErrorReason,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
  readNonBlankString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { applyXaiOAuthConfig, XAI_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildLiveXaiOAuthProvider, buildXaiProvider } from "./provider-catalog.js";
import { xaiUserAgent } from "./src/xai-user-agent.js";

const PROVIDER_ID = "xai";
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_LEGACY_OAUTH_TOKEN_ENDPOINT = `${XAI_OAUTH_ISSUER}/oauth/token`;

const XAI_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const XAI_OAUTH_FETCH_TIMEOUT_MS = 30 * 1000;
const XAI_OAUTH_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const XAI_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5 * 1000;
const XAI_DEVICE_CODE_MIN_INTERVAL_MS = 1 * 1000;
const XAI_DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5 * 1000;
const XAI_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

type XaiOAuthTokenResponse = ReturnType<typeof parseXaiOAuthTokenResponse>;

type XaiOAuthFetchOptions = {
  signal?: AbortSignal;
  assertCurrent?: () => void;
  onResponse?: (status: number) => void;
};

function fetchXaiOAuth(url: string, options: XaiOAuthFetchOptions, body?: Record<string, string>) {
  // The guard rechecks authority after DNS and each redirect; raw fetch follows
  // redirects internally and cannot fence the next request after owner retirement.
  return fetchWithSsrFGuard({
    url,
    beforeRequest: options.assertCurrent,
    onResponse: options.onResponse,
    mode: "trusted_explicit_proxy",
    resolveDispatcherPolicy: (target) => {
      // Operator-owned proxies may be local; NO_PROXY must be reevaluated for every hop.
      const proxies = resolveEnvHttpProxyAgentOptions();
      const proxyUrl = target.protocol === "https:" ? proxies?.httpsProxy : proxies?.httpProxy;
      return proxyUrl && !matchesNoProxy(target.toString())
        ? { mode: "explicit-proxy", proxyUrl, allowPrivateProxy: true }
        : undefined;
    },
    signal: options.signal,
    timeoutMs: XAI_OAUTH_FETCH_TIMEOUT_MS,
    requireHttps: true,
    auditContext: "xai-oauth",
    init: {
      headers: {
        Accept: "application/json",
        "User-Agent": xaiUserAgent(),
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(body ? { method: "POST", body: toFormUrlEncoded(body) } : {}),
    },
  });
}

function requireTrustedXaiOAuthEndpoint(endpoint: string, label: string): string {
  const url = URL.parse(endpoint);
  if (url?.protocol === "https:" && (url.hostname === "x.ai" || url.hostname.endsWith(".x.ai"))) {
    return endpoint;
  }
  throw new Error(`xAI OAuth discovery returned untrusted ${label}`);
}

async function readResponseBody(
  { response, release }: Awaited<ReturnType<typeof fetchXaiOAuth>>,
  options: { fatalUtf8?: boolean } = {},
) {
  try {
    const buffer = await readResponseWithLimit(response, XAI_OAUTH_RESPONSE_MAX_BYTES, {
      onOverflow: ({ maxBytes }) => new Error(`xAI OAuth response exceeds ${maxBytes} bytes`),
    });
    const text = new TextDecoder("utf-8", { fatal: options.fatalUtf8 }).decode(buffer);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { json, text };
  } finally {
    await release();
  }
}

async function readJsonResponse(
  result: Awaited<ReturnType<typeof fetchXaiOAuth>>,
  context: string,
): Promise<unknown> {
  const { response } = result;
  const body = await readResponseBody(result);
  if (!response.ok) {
    const json = asOptionalRecord(body.json);
    const errorText = json?.error_description ?? json?.error;
    throw Object.assign(
      new Error(
        `${context} failed (${response.status})${typeof errorText === "string" ? `: ${errorText}` : ""}`,
      ),
      { status: response.status, reason: readOAuthRefreshErrorReason(body.json) },
    );
  }
  return body.json;
}

async function fetchXaiOAuthDiscoveryDocument(
  options: XaiOAuthFetchOptions = {},
): Promise<Record<string, unknown>> {
  const response = await fetchXaiOAuth(XAI_OAUTH_DISCOVERY_URL, options);
  return asOptionalRecord(await readJsonResponse(response, "xAI OAuth discovery")) ?? {};
}

function parseXaiOAuthTokenResponse(
  value: unknown,
  options: { requireRefreshToken?: boolean } = {},
) {
  const json = asOptionalRecord(value) ?? {};
  const accessToken = readNonBlankString(json.access_token);
  if (!accessToken) {
    throw new Error("xAI OAuth token response is missing access_token");
  }
  const refreshToken = readNonBlankString(json.refresh_token);
  if ((options.requireRefreshToken || json.refresh_token !== undefined) && !refreshToken) {
    throw new Error(
      "xAI OAuth token response is missing refresh_token. Re-run the login; if the issue persists, the OAuth client is not configured to issue refresh tokens (commonly because the offline_access scope was rejected).",
    );
  }
  const idToken = readNonBlankString(json.id_token);
  // RFC 6749 expires_in preferred; access-token JWT exp is the only legitimate
  // fallback for an access-token expiry — id_token exp reflects the OIDC
  // session, not the access token, and may extend it past actual expiry.
  const expires =
    resolveExpiresAtMsFromDurationSeconds(json.expires_in, { nowMs: Date.now() }) ??
    resolveExpiresAtMsFromEpochSeconds(decodeJwtPayload(accessToken).exp);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(idToken ? { idToken } : {}),
    ...(expires ? { expires } : {}),
  };
}

// RFC 6749 final codes that the shared refresh-reason reader does not classify.
const XAI_FINAL_OAUTH_ERRORS = new Set(["invalid_request", "access_denied"]);

async function requestXaiOAuthRefresh(
  tokenEndpoint: string,
  refreshToken: string,
): Promise<XaiOAuthTokenResponse> {
  const endpoint = requireTrustedXaiOAuthEndpoint(tokenEndpoint, "token endpoint");
  const context = "xAI OAuth refresh";
  const maxChallengeAttempts = 3;
  for (let attempt = 1; attempt <= maxChallengeAttempts; attempt++) {
    let result: Awaited<ReturnType<typeof fetchXaiOAuth>>;
    try {
      result = await fetchXaiOAuth(
        endpoint,
        {},
        {
          grant_type: "refresh_token",
          client_id: XAI_OAUTH_CLIENT_ID,
          refresh_token: refreshToken,
        },
      );
    } catch (cause) {
      // No headers does not mean the server did not consume a rotating grant.
      throw createOAuthRefreshError(
        context + " transport failed",
        {
          version: 1,
          phase: "token-response",
          outcome: "unknown",
        },
        { cause },
      );
    }
    const { response } = result;
    // Cloudflare documents this header as an intermediary response replacing the origin response.
    // HTML alone is not nonconsumption evidence, and must never replay a rotating grant.
    if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
      try {
        await response.body?.cancel();
      } finally {
        await result.release();
      }
      if (attempt < maxChallengeAttempts) {
        await sleepWithAbort(250);
      }
      continue;
    }
    let body: Awaited<ReturnType<typeof readResponseBody>>;
    try {
      body = await readResponseBody(result, { fatalUtf8: true });
    } catch (cause) {
      throw createOAuthRefreshError(
        context + " response could not be read",
        {
          version: 1,
          phase: "token-response",
          outcome: "unknown",
          status: response.status,
        },
        { cause },
      );
    }
    if (!response.ok || asOptionalRecord(body.json)?.error !== undefined) {
      const oauthError = asOptionalRecord(body.json)?.error;
      const code =
        readStringValue(oauthError) ?? readStringValue(asOptionalRecord(oauthError)?.code);
      // Jason's 2026-10-21 product decision for xAI (PR #178646): a 429/5xx keeps the
      // stored sign-in for a later refresh unless its OAuth error is final. The shared
      // helper already keeps refresh-specific terminal reasons rejected. xAI does not
      // document grant reuse, so lost or unreadable responses stay fenced.
      const error = createOAuthRefreshResponseError(
        context,
        response.status,
        body.json,
        code && XAI_FINAL_OAUTH_ERRORS.has(code) ? undefined : "owner-accepted-provider-retry",
      );
      // HTML is not OAuth JSON; the status above decides recovery and this only adds a hint.
      if (
        !asOptionalRecord(body.json)?.error &&
        (response.headers.get("cf-mitigated") === "challenge" ||
          /text\/html/i.test(response.headers.get("content-type") ?? "") ||
          /<!doctype html|<html\b/i.test(body.text))
      ) {
        error.message +=
          ": xAI returned an HTML/Cloudflare challenge instead of OAuth JSON. Re-run xAI OAuth login if it persists.";
      }
      throw error;
    }
    try {
      return parseXaiOAuthTokenResponse(body.json);
    } catch (cause) {
      throw createOAuthRefreshError(
        context + " returned invalid credentials",
        {
          version: 1,
          phase: "after-token-response",
          outcome: "unknown",
          status: response.status,
        },
        { cause },
      );
    }
  }
  throw createOAuthRefreshError(context + " blocked by a Cloudflare challenge; retry later", {
    version: 1,
    phase: "token-response",
    outcome: "unchanged",
    status: 403,
    recovery: { kind: "later", evidence: "verified-intermediary-challenge" },
  });
}

function resolveNextXaiDeviceCodePollDelayMs(intervalMs: number, deadlineMs: number): number {
  const remainingMs = Math.max(0, deadlineMs - performance.now());
  return Math.min(Math.max(intervalMs, XAI_DEVICE_CODE_MIN_INTERVAL_MS), remainingMs);
}

async function waitForXaiDeviceCodePoll(delayMs: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleepWithAbort(delayMs, signal);
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("xAI login cancelled");
    }
    throw error;
  }
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> {
  if (!token) {
    return {};
  }
  const part = token.split(".")[1];
  if (!part) {
    return {};
  }
  try {
    return asOptionalRecord(JSON.parse(Buffer.from(part, "base64url").toString("utf8"))) ?? {};
  } catch {
    return {};
  }
}

function resolveXaiOAuthIdentity(tokens: XaiOAuthTokenResponse) {
  const payload = decodeJwtPayload(tokens.idToken ?? tokens.accessToken);
  const email = typeof payload.email === "string" ? payload.email : undefined;
  const name = typeof payload.name === "string" ? payload.name : undefined;
  const sub = typeof payload.sub === "string" ? payload.sub : undefined;
  return {
    ...(email ? { email } : {}),
    ...(name ? { displayName: name } : {}),
    ...(sub ? { accountId: sub } : {}),
  };
}

function isLegacyXaiOAuthTokenEndpoint(endpoint: string): boolean {
  const url = URL.parse(endpoint);
  return url !== null && `${url.origin}${url.pathname}` === XAI_LEGACY_OAUTH_TOKEN_ENDPOINT;
}

async function resolveXaiOAuthRefreshTokenEndpoint(credential: OAuthCredential): Promise<string> {
  const cachedEndpoint = normalizeOptionalString(credential.tokenEndpoint);
  // Rediscover when there is no cached endpoint, or when an older persisted
  // credential still points at the retired endpoint, so refresh writes back the
  // current OAuth token endpoint.
  if (!cachedEndpoint || isLegacyXaiOAuthTokenEndpoint(cachedEndpoint)) {
    let discovery: Record<string, unknown>;
    try {
      discovery = await fetchXaiOAuthDiscoveryDocument();
    } catch (cause) {
      // Discovery is a GET before the refresh grant is submitted at all.
      throw createOAuthRefreshError(
        "xAI OAuth discovery failed before refresh dispatch",
        {
          version: 1,
          phase: "before-dispatch",
          outcome: "not-attempted",
          recovery: { kind: "later", evidence: "dispatch-not-started" },
        },
        { cause },
      );
    }
    if (typeof discovery.token_endpoint !== "string") {
      throw new Error("xAI OAuth discovery response is missing the token endpoint");
    }
    return requireTrustedXaiOAuthEndpoint(discovery.token_endpoint, "token endpoint");
  }
  return cachedEndpoint;
}

export async function loginXaiDeviceCode(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const progress = ctx.prompter.progress("Starting xAI OAuth...");
  const requestOptions = { signal: ctx.signal, assertCurrent: ctx.assertCurrent };
  try {
    const discovery = await fetchXaiOAuthDiscoveryDocument(requestOptions);
    const rawDeviceAuthorizationEndpoint = discovery.device_authorization_endpoint;
    const rawTokenEndpoint = discovery.token_endpoint;
    if (
      typeof rawDeviceAuthorizationEndpoint !== "string" ||
      typeof rawTokenEndpoint !== "string"
    ) {
      throw new Error("xAI OAuth discovery response is missing device code endpoints");
    }
    const deviceAuthorizationEndpoint = requireTrustedXaiOAuthEndpoint(
      rawDeviceAuthorizationEndpoint,
      "device authorization endpoint",
    );
    const tokenEndpoint = requireTrustedXaiOAuthEndpoint(rawTokenEndpoint, "token endpoint");
    progress.update("Requesting xAI OAuth device code...");
    const response = await fetchXaiOAuth(
      requireTrustedXaiOAuthEndpoint(deviceAuthorizationEndpoint, "device authorization endpoint"),
      requestOptions,
      { client_id: XAI_OAUTH_CLIENT_ID, scope: XAI_OAUTH_SCOPE },
    );
    const json =
      asOptionalRecord(await readJsonResponse(response, "xAI device code request")) ?? {};
    const deviceCode = readNonBlankString(json.device_code);
    const userCode = readNonBlankString(json.user_code);
    const verificationUri = readNonBlankString(json.verification_uri);
    const verificationUriComplete = readNonBlankString(json.verification_uri_complete);
    if (!deviceCode || !userCode || !verificationUri) {
      throw new Error(
        "xAI device code response is missing device_code, user_code, or verification_uri",
      );
    }
    const trustedVerificationUri = requireTrustedXaiOAuthEndpoint(
      verificationUri,
      "device verification URI",
    );
    const trustedVerificationUriComplete = verificationUriComplete
      ? requireTrustedXaiOAuthEndpoint(verificationUriComplete, "complete device verification URI")
      : undefined;
    const expiresInMs = positiveSecondsToSafeMilliseconds(json.expires_in) ?? XAI_OAUTH_TIMEOUT_MS;
    const intervalMs =
      positiveSecondsToSafeMilliseconds(json.interval) ?? XAI_DEVICE_CODE_DEFAULT_INTERVAL_MS;
    const browserUrl = trustedVerificationUriComplete ?? trustedVerificationUri;
    let openedBrowser = false;
    try {
      await ctx.openUrl(browserUrl);
      openedBrowser = true;
    } catch {
      ctx.runtime.log(`Open manually: ${trustedVerificationUri}`);
    }
    const expiresInMinutes = Math.max(1, Math.round(expiresInMs / 60_000));
    if (ctx.prompter.deviceCode) {
      await ctx.prompter.deviceCode({
        title: "xAI OAuth",
        code: userCode,
        expiresInMinutes,
        message: "Enter this one-time code on the sign-in page.",
      });
    } else {
      await ctx.prompter.note(
        [
          ctx.isRemote
            ? "Open this URL in your LOCAL browser and enter the code below."
            : "Open this URL in your browser and enter the code below.",
          `URL: <${trustedVerificationUriComplete ?? trustedVerificationUri}>`,
          `Code: ${userCode}`,
          `Code expires in ${expiresInMinutes} minutes. Never share it.`,
        ].join("\n"),
        "xAI OAuth",
      );
    }
    const logUrl = trustedVerificationUri;
    if (ctx.isRemote) {
      ctx.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${logUrl}\n`);
    } else if (openedBrowser) {
      ctx.runtime.log(`Open: ${logUrl}`);
    }

    progress.update("Waiting for xAI device authorization...");
    const pollXaiDeviceCodeToken = async (): Promise<XaiOAuthTokenResponse> => {
      const deadlineMs = performance.now() + expiresInMs;
      let pollIntervalMs = intervalMs;

      while (performance.now() < deadlineMs) {
        const result = await fetchXaiOAuth(
          requireTrustedXaiOAuthEndpoint(tokenEndpoint, "token endpoint"),
          requestOptions,
          {
            grant_type: XAI_DEVICE_CODE_GRANT_TYPE,
            client_id: XAI_OAUTH_CLIENT_ID,
            device_code: deviceCode,
          },
        );
        const { response: tokenResponse } = result;
        let body: unknown;
        try {
          body = (await readResponseBody(result, { fatalUtf8: true })).json;
        } catch {
          body = null;
        }
        if (tokenResponse.ok) {
          return parseXaiOAuthTokenResponse(body, {
            requireRefreshToken: true,
          });
        }

        const errorBody = asOptionalRecord(body);
        const error = readStringValue(errorBody?.error);
        if (error === "authorization_pending" || error === "slow_down") {
          if (error === "slow_down") {
            pollIntervalMs += XAI_DEVICE_CODE_SLOW_DOWN_INCREMENT_MS;
          }
          await waitForXaiDeviceCodePoll(
            resolveNextXaiDeviceCodePollDelayMs(pollIntervalMs, deadlineMs),
            requestOptions.signal,
          );
          continue;
        }
        if (error === "access_denied" || error === "authorization_denied") {
          throw new Error("xAI device authorization was denied");
        }
        if (error === "expired_token") {
          throw new Error("xAI device code expired. Re-run the login.");
        }

        const description = readStringValue(errorBody?.error_description);
        const prefix = `xAI device token exchange failed (${tokenResponse.status})`;
        throw new Error(
          error ? `${prefix}: ${error}${description ? ` (${description})` : ""}` : prefix,
        );
      }

      throw new Error("xAI device authorization timed out");
    };
    const tokens = await pollXaiDeviceCodeToken();
    const identity = resolveXaiOAuthIdentity(tokens);
    const provider = ctx.credentialOnly
      ? buildXaiProvider("openai-responses", "oauth")
      : await buildLiveXaiOAuthProvider({
          discoveryApiKey: tokens.accessToken,
          signal: ctx.signal,
          fetchGuard: (params) =>
            fetchWithSsrFGuard({ ...params, beforeRequest: ctx.assertCurrent }),
        });
    progress.stop("xAI OAuth complete");
    return buildOauthProviderAuthResult({
      providerId: PROVIDER_ID,
      defaultModel: XAI_DEFAULT_MODEL_REF,
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      expires: tokens.expires,
      email: identity.email,
      displayName: identity.displayName,
      profileName: identity.email ?? identity.accountId,
      configPatch: applyXaiOAuthConfig(ctx.credentialOnly ? {} : ctx.config, provider),
      credentialExtra: {
        tokenEndpoint,
        deviceAuthorizationEndpoint,
        issuer: XAI_OAUTH_ISSUER,
        authFlow: "device-code",
        ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
        ...(identity.accountId ? { accountId: identity.accountId } : {}),
      },
      notes: [
        "xAI OAuth uses device-code verification without requiring a localhost callback.",
        "xAI may label the consent app as Grok Build because OpenClaw uses xAI's shared OAuth client.",
      ],
    });
  } catch (err) {
    progress.stop("xAI OAuth failed");
    throw new Error(`xAI OAuth failed: ${formatErrorMessage(err)}`, { cause: err });
  }
}

export async function refreshXaiOAuthCredential(
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  const refreshToken = credential.refresh;
  if (!refreshToken) {
    throw new Error("xAI OAuth credential is missing refresh token");
  }
  const tokenEndpoint = await resolveXaiOAuthRefreshTokenEndpoint(credential);
  const tokens = await requestXaiOAuthRefresh(tokenEndpoint, refreshToken);
  return {
    ...credential,
    type: "oauth",
    provider: PROVIDER_ID,
    access: tokens.accessToken,
    refresh: tokens.refreshToken ?? refreshToken,
    ...(tokens.expires ? { expires: tokens.expires } : {}),
    ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
    ...resolveXaiOAuthIdentity(tokens),
    tokenEndpoint,
    issuer: XAI_OAUTH_ISSUER,
  };
}
