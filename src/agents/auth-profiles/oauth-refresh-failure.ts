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
  | "token_invalidated"
  | "revoked";

type OAuthRefreshFailure = {
  provider: string | null;
  reason: OAuthRefreshFailureReason | null;
  profileId?: string | null;
};

/** Error type that carries provider and classified OAuth refresh failure reason. */
export class OAuthRefreshFailureError extends Error {
  readonly provider: string;
  readonly reason: OAuthRefreshFailureReason | null;
  readonly profileId?: string;

  constructor(params: { provider: string; message: string; cause?: unknown; profileId?: string }) {
    super(params.message, { cause: params.cause });
    this.name = "OAuthRefreshFailureError";
    this.provider = params.provider;
    this.reason = classifyOAuthRefreshFailureReason(params.message);
    this.profileId = params.profileId;
  }
}

const OAUTH_REFRESH_FAILURE_PROVIDER_RE = /OAuth token refresh failed for ([^:]+):/i;
const SAFE_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_PROFILE_ID_RE = /^[a-z0-9][a-z0-9._:@+-]*$/;

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

function sanitizeOAuthRefreshFailureProfileId(
  profileId: string | null | undefined,
  provider: string,
): string | null {
  const sanitized = profileId ? sanitizeForLog(profileId).replaceAll("`", "").trim() : "";
  return sanitized && SAFE_PROFILE_ID_RE.test(sanitized) && sanitized.startsWith(`${provider}:`)
    ? sanitized
    : null;
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
  if (lower.includes("token_invalidated")) {
    return "token_invalidated";
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

/** Classify provider/reason from the structured OAuth refresh failure error. */
export function classifyOAuthRefreshFailureError(err: unknown): OAuthRefreshFailure | null {
  if (!(err instanceof OAuthRefreshFailureError)) {
    return null;
  }
  const provider = sanitizeOAuthRefreshFailureProvider(err.provider);
  const profileId = provider ? sanitizeOAuthRefreshFailureProfileId(err.profileId, provider) : null;
  return {
    provider,
    reason: err.reason,
    ...(profileId ? { profileId } : {}),
  };
}

/** Build the login command operators should run after OAuth refresh failure. */
export function buildOAuthRefreshFailureLoginCommand(
  provider: string | null | undefined,
  options?: { profileId?: string | null },
): string {
  const sanitizedProvider = sanitizeOAuthRefreshFailureProvider(provider);
  const sanitizedProfileId = sanitizedProvider
    ? sanitizeOAuthRefreshFailureProfileId(options?.profileId, sanitizedProvider)
    : null;
  return sanitizedProvider
    ? formatCliCommand(
        sanitizedProfileId
          ? `openclaw models auth login --provider ${sanitizedProvider} --profile-id ${sanitizedProfileId}`
          : `openclaw models auth login --provider ${sanitizedProvider}`,
      )
    : formatCliCommand("openclaw models auth login");
}
