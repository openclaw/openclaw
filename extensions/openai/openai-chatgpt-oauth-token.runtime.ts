import {
  ProviderAuthFailure,
  resolveOpenAICodexAccessTokenExpiry,
} from "openclaw/plugin-sdk/provider-auth";
import {
  createOAuthRefreshResponseError,
  type OAuthRefreshOutcome,
  resolveOAuthTokenExpiresAt,
  throwIfOAuthLoginAborted,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { parseRetryAfterHeaderSeconds } from "openclaw/plugin-sdk/retry-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asOptionalRecord,
  isRecord,
  normalizeBoundedOptionalString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/terminal-safe-text";
import {
  createOpenAIAuthorizationCodeForm,
  OPENAI_CODEX_CLIENT_ID,
  withOpenAIOAuthResponse,
} from "./openai-oauth-http.runtime.js";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_TOKEN_SSRF_POLICY = {
  allowRfc2544BenchmarkRange: true,
  allowIpv6UniqueLocalRange: true,
  hostnameAllowlist: ["auth.openai.com"],
} satisfies SsrFPolicy;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const OAUTH_TOKEN_RESPONSE_BODY_LIMIT_BYTES = 1 * 1024 * 1024;
const OAUTH_TOKEN_ERROR_SUMMARY_MAX_CHARS = 500;

type TokenSuccess = { type: "success"; access: string; refresh: string; expires: number };
type TokenFailureReason =
  | "refresh_token_reused"
  | "expired"
  | "invalid_grant"
  | "invalid_refresh_token"
  | "token_invalidated"
  | "revoked";
type TokenFailure = {
  type: "failed";
  operation: "exchange" | "refresh";
  summary: string;
  cancelled?: true;
  code?: string;
  errorType?: string;
  reason?: TokenFailureReason;
  status?: number;
  retryAfterMs?: number;
  oauthRefreshOutcome?: OAuthRefreshOutcome;
};
type TokenResult = TokenSuccess | TokenFailure;
type TokenRequestOptions = {
  signal?: AbortSignal;
  assertCurrent?: () => void;
  timeoutMs?: number;
};

const TOKEN_FAILURE_REASON_BY_CODE: Readonly<Record<string, TokenFailureReason>> = {
  invalid_grant: "invalid_grant",
  invalid_refresh_token: "invalid_refresh_token",
  refresh_token_expired: "expired",
  refresh_token_invalidated: "token_invalidated",
  refresh_token_reused: "refresh_token_reused",
};
const REGION_BLOCKED_CODE = "unsupported_country_region_territory";
const TOKEN_FAILURE_CODES = new Set([
  ...Object.keys(TOKEN_FAILURE_REASON_BY_CODE),
  REGION_BLOCKED_CODE,
]);

/** The one OpenAI auth error-text sanitizer: single line, no terminal controls, redacted, bounded. */
export function normalizeTokenErrorSummary(value: unknown): string | undefined {
  const normalized = normalizeBoundedOptionalString(value, OAUTH_TOKEN_ERROR_SUMMARY_MAX_CHARS * 4);
  const text = normalized && sanitizeTerminalText(normalized.replace(/\s+/gu, " ")).trim();
  return text
    ? normalizeBoundedOptionalString(
        redactSensitiveText(text, { mode: "tools" }),
        OAUTH_TOKEN_ERROR_SUMMARY_MAX_CHARS,
      )
    : undefined;
}

/**
 * Sign-in failure for an OpenAI auth endpoint answer. `status` is absent when the request
 * itself failed. Refresh failures keep their own `oauthRefreshFailure` facts instead.
 */
export function createOpenAISignInFailure(
  failure: { status?: number; code?: string; summary?: string; retryAfterMs?: number },
  rejected: "grant_rejected" | "device_code_denied" = "grant_rejected",
): ProviderAuthFailure {
  const cause = failure.summary ? new Error(failure.summary) : undefined;
  if (!failure.status) {
    return new ProviderAuthFailure("network", { cause });
  }
  if (failure.status === 429) {
    return new ProviderAuthFailure("rate_limited", { retryAfterMs: failure.retryAfterMs, cause });
  }
  if (failure.status >= 500) {
    return new ProviderAuthFailure("provider_unavailable", { cause });
  }
  if (failure.code === REGION_BLOCKED_CODE) {
    return new ProviderAuthFailure("host_network_blocked", {
      providerDetail:
        "OpenAI does not allow sign-in from this computer's country, region, or network route. If you normally use a proxy, make sure the OpenClaw process uses it.",
      cause,
    });
  }
  return new ProviderAuthFailure(rejected, {
    ...(rejected === "grant_rejected" ? { providerDetail: failure.summary } : {}),
    cause,
  });
}

function buildTokenResponseFailure(params: {
  response: Response;
  operation: "exchange" | "refresh";
  text: string;
}): TokenFailure {
  let body: Record<string, unknown> | undefined;
  try {
    body = asOptionalRecord(JSON.parse(params.text));
  } catch {
    // Non-JSON responses use the bounded generic message below.
  }
  const error = asOptionalRecord(body?.error);
  const rawCode = normalizeOptionalString(
    error?.code ?? (typeof body?.error === "string" ? body.error : body?.code),
  )?.toLowerCase();
  const code = rawCode && TOKEN_FAILURE_CODES.has(rawCode) ? rawCode : undefined;
  const rawType = normalizeOptionalString(error?.type ?? body?.type)?.toLowerCase();
  const errorType =
    rawType === "invalid_grant" || rawType === "invalid_request_error" ? rawType : undefined;
  const reason = code ? TOKEN_FAILURE_REASON_BY_CODE[code] : undefined;
  const summary =
    normalizeTokenErrorSummary(error?.message ?? body?.error_description ?? body?.message) ??
    `OpenAI Codex token ${params.operation} failed (HTTP ${params.response.status}).`;
  const retryAfterSeconds = parseRetryAfterHeaderSeconds(
    params.response.headers.get("retry-after"),
  );
  return {
    type: "failed",
    operation: params.operation,
    summary,
    status: params.response.status,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterMs: retryAfterSeconds * 1000 }),
    ...(params.operation === "refresh"
      ? {
          oauthRefreshOutcome: createOAuthRefreshResponseError(
            "OpenAI token refresh",
            params.response.status,
            body,
          ).oauthRefreshOutcome,
        }
      : {}),
    ...(code ? { code } : {}),
    ...(errorType ? { errorType } : {}),
    ...(reason ? { reason } : {}),
  };
}

function formatTokenRequestError(
  operation: "exchange" | "refresh",
  error: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): string {
  if (signal?.aborted) {
    return "Login cancelled";
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return `OpenAI Codex token ${operation} timed out after ${timeoutMs}ms`;
  }
  const detail = normalizeTokenErrorSummary(error instanceof Error ? error.message : String(error));
  return (
    normalizeTokenErrorSummary(
      `OpenAI Codex token ${operation} error${detail ? `: ${detail}` : ""}`,
    ) ?? `OpenAI Codex token ${operation} error`
  );
}

async function requestOpenAIToken(
  body: URLSearchParams,
  operation: "exchange" | "refresh",
  options: TokenRequestOptions = {},
  existingRefreshToken?: string,
): Promise<TokenResult> {
  const timeoutMs = options.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS;
  try {
    throwIfOAuthLoginAborted(options.signal);
    const { response: tokenResponse, text } = await withOpenAIOAuthResponse(
      {
        url: TOKEN_URL,
        // Keep direct DNS pinning without a proxy; the exact-host policy permits fake-IP DNS.
        mode: "trusted_env_proxy",
        policy: OAUTH_TOKEN_SSRF_POLICY,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        },
        timeoutMs,
        signal: options.signal,
        beforeRequest: options.assertCurrent,
        auditContext: "openai-chatgpt-oauth-token",
      },
      async (response) => {
        const bytes = await readResponseWithLimit(response, OAUTH_TOKEN_RESPONSE_BODY_LIMIT_BYTES, {
          onOverflow: ({ size, maxBytes }) =>
            new Error(
              `OpenAI Codex OAuth token response body too large: ${size} bytes (limit: ${maxBytes} bytes)`,
            ),
        });
        return { response, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
      },
    );
    const result = readOpenAITokenResponse(tokenResponse, text, operation, existingRefreshToken);
    return result.type === "failed" && operation === "refresh"
      ? {
          ...result,
          oauthRefreshOutcome: result.oauthRefreshOutcome ?? {
            version: 1,
            phase: "after-token-response",
            outcome: "unknown",
            status: tokenResponse.status,
          },
        }
      : result;
  } catch (error) {
    return {
      type: "failed",
      operation,
      ...(operation === "refresh"
        ? {
            oauthRefreshOutcome: {
              version: 1,
              phase: "token-response",
              outcome: "unknown",
            } as const,
          }
        : {}),
      ...(options.signal?.aborted ? { cancelled: true } : {}),
      summary: formatTokenRequestError(operation, error, timeoutMs, options.signal),
    };
  }
}

function readOpenAITokenResponse(
  response: Response,
  text: string,
  operation: "exchange" | "refresh",
  existingRefreshToken?: string,
): TokenResult {
  if (!response.ok) {
    return buildTokenResponseFailure({ response, operation, text });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      type: "failed",
      operation,
      summary: `OpenAI Codex token ${operation} failed: response is not valid JSON`,
    };
  }
  if (!isRecord(json)) {
    return {
      type: "failed",
      operation,
      summary: `OpenAI Codex token ${operation} failed: expected JSON object response`,
    };
  }
  if (json.error !== undefined) {
    return buildTokenResponseFailure({ response, operation, text });
  }
  const access = normalizeOptionalString(json.access_token);
  // Sign-in responses may omit expires_in; the access token's own JWT expiry then applies.
  const expires =
    resolveOAuthTokenExpiresAt(json.expires_in) ??
    (operation === "exchange" && access ? resolveOpenAICodexAccessTokenExpiry(access) : undefined);
  const refreshToken =
    json.refresh_token === undefined
      ? existingRefreshToken
      : normalizeOptionalString(json.refresh_token);
  if (!access || !refreshToken || expires === undefined) {
    const missing = [
      access ? "" : "access_token",
      refreshToken ? "" : "refresh_token",
      expires === undefined ? "expires_in" : "",
    ];
    return {
      type: "failed",
      operation,
      summary: `OpenAI Codex token ${operation} response missing fields: ${missing.filter(Boolean).join(", ")}`,
    };
  }
  return {
    type: "success",
    access,
    refresh: refreshToken,
    expires,
  };
}

export async function exchangeOpenAIAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string,
  options: TokenRequestOptions = {},
): Promise<TokenResult> {
  return await requestOpenAIToken(
    createOpenAIAuthorizationCodeForm({
      clientId: OPENAI_CODEX_CLIENT_ID,
      code,
      verifier,
      redirectUri,
    }),
    "exchange",
    options,
  );
}

export async function refreshOpenAIAccessToken(
  refreshToken: string,
  options: TokenRequestOptions = {},
): Promise<TokenResult> {
  return await requestOpenAIToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
    "refresh",
    options,
    refreshToken,
  );
}
