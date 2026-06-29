/**
 * OAuth refresh failure classification and operator hints.
 * Parses provider/reason codes from refresh failures and formats safe login
 * commands without trusting raw provider text.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { formatCliCommand } from "../../cli/command-format.js";

export type OAuthRefreshFailureReason =
  | "refresh_token_reused"
  | "invalid_grant"
  | "sign_in_again"
  | "invalid_refresh_token"
  | "revoked";

type OAuthRefreshFailure = {
  provider: string | null;
  reason: OAuthRefreshFailureReason | null;
};

/** Error type that carries provider and classified OAuth refresh failure reason. */
export class OAuthRefreshFailureError extends Error {
  readonly provider: string;
  readonly reason: OAuthRefreshFailureReason | null;

  constructor(params: { provider: string; message: string; cause?: unknown }) {
    super(params.message, { cause: params.cause });
    this.name = "OAuthRefreshFailureError";
    this.provider = params.provider;
    this.reason = classifyOAuthRefreshFailureReason(params.message);
  }
}

const OAUTH_REFRESH_FAILURE_PROVIDER_RE = /OAuth token refresh failed for ([^:]+):/i;
const SAFE_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const CLAUDE_CLI_AUTH_FAILURE_RE =
  /\bfailed to authenticate\b[\s\S]*\b401\b[\s\S]*\binvalid authentication credentials\b/i;

function isOAuthRefreshFailureMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("oauth token refresh failed") ||
    lower.includes("access token could not be refreshed") ||
    lower.includes("authentication session could not be refreshed automatically")
  );
}

function extractOAuthRefreshFailureProvider(message: string): string | null {
  const provider = message.match(OAUTH_REFRESH_FAILURE_PROVIDER_RE)?.[1]?.trim();
  return provider && provider.length > 0 ? provider : null;
}

function sanitizeOAuthRefreshFailureProvider(provider: string | null | undefined): string | null {
  // Only return normalized provider ids that are safe to embed in shell guidance.
  const sanitized = provider ? sanitizeForLog(provider).replaceAll("`", "").trim() : "";
  const normalized = normalizeProviderId(sanitized);
  return normalized && SAFE_PROVIDER_ID_RE.test(normalized) ? normalized : null;
}

/** Classify a raw OAuth refresh failure message into a stable reason code. */
export function classifyOAuthRefreshFailureReason(
  message: string,
): OAuthRefreshFailureReason | null {
  const lower = message.toLowerCase();
  if (lower.includes("refresh_token_reused")) {
    return "refresh_token_reused";
  }
  if (lower.includes("invalid_grant")) {
    return "invalid_grant";
  }
  if (lower.includes("signing in again") || lower.includes("sign in again")) {
    return "sign_in_again";
  }
  if (lower.includes("invalid refresh token")) {
    return "invalid_refresh_token";
  }
  if (lower.includes("expired or revoked") || lower.includes("revoked")) {
    return "revoked";
  }
  return null;
}

/** Classify provider/reason from a user-facing OAuth refresh failure message. */
export function classifyOAuthRefreshFailure(message: string): OAuthRefreshFailure | null {
  if (!isOAuthRefreshFailureMessage(message)) {
    return null;
  }
  return {
    provider: sanitizeOAuthRefreshFailureProvider(extractOAuthRefreshFailureProvider(message)),
    reason: classifyOAuthRefreshFailureReason(message),
  };
}

/**
 * Claude CLI 401s come from its local OAuth login state, not inherited API keys,
 * so route that typed provider failure through the existing re-auth hint path.
 */
export function classifyProviderOAuthAuthenticationFailure(params: {
  provider: string | null | undefined;
  message: string;
}): OAuthRefreshFailure | null {
  const provider = sanitizeOAuthRefreshFailureProvider(params.provider);
  if (provider !== "claude-cli" || !CLAUDE_CLI_AUTH_FAILURE_RE.test(params.message)) {
    return null;
  }
  return {
    provider,
    reason: "sign_in_again",
  };
}

/** Classify provider/reason from the structured OAuth refresh failure error. */
export function classifyOAuthRefreshFailureError(err: unknown): OAuthRefreshFailure | null {
  if (!(err instanceof OAuthRefreshFailureError)) {
    return null;
  }
  return {
    provider: sanitizeOAuthRefreshFailureProvider(err.provider),
    reason: err.reason,
  };
}

/** Build the login command operators should run after OAuth refresh failure. */
export function buildOAuthRefreshFailureLoginCommand(provider: string | null | undefined): string {
  const sanitizedProvider = sanitizeOAuthRefreshFailureProvider(provider);
  return sanitizedProvider
    ? formatCliCommand(`openclaw models auth login --provider ${sanitizedProvider}`)
    : formatCliCommand("openclaw models auth login");
}
