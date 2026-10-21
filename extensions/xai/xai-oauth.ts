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
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { sleep, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
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
const XAI_OAUTH_REFRESH_MAX_ATTEMPTS = 3;
const XAI_OAUTH_REFRESH_RETRY_DELAY_MS = 250;
const XAI_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5 * 1000;
const XAI_DEVICE_CODE_MIN_INTERVAL_MS = 1 * 1000;
const XAI_DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5 * 1000;
const XAI_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

type XaiOAuthTokenResponse = ReturnType<typeof parseXaiOAuthTokenResponse>;

type XaiOAuthFetchOptions = {
  signal?: AbortSignal;
  assertCurrent?: () => void;
};

type XaiOAuthResponseBody = Awaited<ReturnType<typeof readResponseBody>>;

function fetchXaiOAuth(url: string, options: XaiOAuthFetchOptions, body?: Record<string, string>) {
  // The guard rechecks authority after DNS and each redirect; raw fetch follows
  // redirects internally and cannot fence the next request after owner retirement.
  return fetchWithSsrFGuard({
    url,
    beforeRequest: options.assertCurrent,
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
    throw new Error(
      `${context} failed (${response.status})${typeof errorText === "string" ? `: ${errorText}` : ""}`,
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
  if (options.requireRefreshToken && !refreshToken) {
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

function formatXaiOAuthError(params: { context: string; status: number; body: unknown }): string {
  const body = asOptionalRecord(params.body);
  const error = readStringValue(body?.error);
  const description = readStringValue(body?.error_description);
  const prefix = `${params.context} failed (${params.status})`;
  return error ? `${prefix}: ${error}${description ? ` (${description})` : ""}` : prefix;
}

async function requestXaiOAuthRefresh(
  tokenEndpoint: string,
  refreshToken: string,
): Promise<XaiOAuthTokenResponse> {
  const endpoint = requireTrustedXaiOAuthEndpoint(tokenEndpoint, "token endpoint");
  const context = "xAI OAuth refresh";

  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    let body: XaiOAuthResponseBody;
    try {
      const result = await fetchXaiOAuth(
        endpoint,
        {},
        {
          grant_type: "refresh_token",
          client_id: XAI_OAUTH_CLIENT_ID,
          refresh_token: refreshToken,
        },
      );
      response = result.response;
      // Successful refresh responses rotate stored credentials. Reject corrupted
      // UTF-8 rather than persisting replacement characters as token bytes.
      body = await readResponseBody(result, { fatalUtf8: response.ok });
    } catch (err) {
      // A lost or unreadable response may already have consumed the refresh token.
      // Only a Cloudflare challenge response is safe to retry below.
      throw new Error(`${context} failed: ${formatErrorMessage(err)}`, { cause: err });
    }
    if (response.ok) {
      return parseXaiOAuthTokenResponse(body.json);
    }

    const status = response.status;
    // Structured OAuth errors are final; only intermediary HTML challenges are retryable.
    const hasStructuredError = Boolean(readStringValue(asOptionalRecord(body.json)?.error));
    let isCloudflareChallenge = false;
    if (!hasStructuredError) {
      const contentType = response.headers.get("content-type") ?? "";
      isCloudflareChallenge =
        response.headers.get("cf-mitigated") === "challenge" ||
        /text\/html/i.test(contentType) ||
        /<!doctype html|<html\b/i.test(body.text) ||
        /\b(?:cloudflare|attention required|just a moment|enable javascript and cookies|challenge-platform)\b/i.test(
          body.text,
        );
    }
    const message = isCloudflareChallenge
      ? `${context} failed (${status}): xAI returned an HTML/Cloudflare challenge ` +
        "instead of OAuth JSON. xAI may be blocking the automated token refresh; try again later " +
        "or re-run xAI OAuth login."
      : formatXaiOAuthError({ context, status, body: body.json });
    if (attempt >= XAI_OAUTH_REFRESH_MAX_ATTEMPTS || !isCloudflareChallenge) {
      throw new Error(message);
    }
    await sleep(XAI_OAUTH_REFRESH_RETRY_DELAY_MS);
  }
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
    const discovery = await fetchXaiOAuthDiscoveryDocument();
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

        const error = readStringValue(asOptionalRecord(body)?.error);
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

        throw new Error(
          formatXaiOAuthError({
            context: "xAI device token exchange",
            status: tokenResponse.status,
            body,
          }),
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
