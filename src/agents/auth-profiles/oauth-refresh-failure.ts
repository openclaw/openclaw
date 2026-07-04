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
  profileId?: string;
  reason: OAuthRefreshFailureReason | null;
};

/** Error type that carries provider and classified OAuth refresh failure reason. */
export class OAuthRefreshFailureError extends Error {
  readonly provider: string;
  readonly profileId?: string;
  readonly reason: OAuthRefreshFailureReason | null;

  constructor(params: { provider: string; profileId?: string; message: string; cause?: unknown }) {
    super(params.message, { cause: params.cause });
    this.name = "OAuthRefreshFailureError";
    this.provider = params.provider;
    this.profileId = params.profileId;
    this.reason = classifyOAuthRefreshFailureReason(params.message);
  }
}

const OAUTH_REFRESH_FAILURE_PROVIDER_RE = /OAuth token refresh failed for ([^:]+):/i;
const SAFE_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

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

function sanitizeOAuthRefreshFailureProfileId(profileId: string | null | undefined): string | null {
  const sanitized = profileId ? sanitizeForLog(profileId).trim() : "";
  return sanitized || null;
}

function quoteShellArg(value: string): string {
  const escaped =
    process.platform === "win32" ? value.replaceAll("'", "''") : value.replaceAll("'", "'\\''");
  return `'${escaped}'`;
}

/** Wrap a rendered login command in a Markdown code span that survives embedded backticks. */
export function formatOAuthRefreshFailureLoginCommandMarkdown(command: string): string {
  let fence = "`";
  while (command.includes(fence)) {
    fence += "`";
  }
  const padding = command.startsWith("`") || command.endsWith("`") ? " " : "";
  return `${fence}${padding}${command}${padding}${fence}`;
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
  const seen = new Set<object>();
  let candidate = err;
  while (candidate && typeof candidate === "object") {
    if (candidate instanceof OAuthRefreshFailureError) {
      const profileId = sanitizeOAuthRefreshFailureProfileId(candidate.profileId);
      return {
        provider: sanitizeOAuthRefreshFailureProvider(candidate.provider),
        ...(profileId ? { profileId } : {}),
        reason: candidate.reason,
      };
    }
    if (seen.has(candidate)) {
      return null;
    }
    seen.add(candidate);
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return null;
}

/** Build the login command operators should run after OAuth refresh failure. */
export function buildOAuthRefreshFailureLoginCommand(
  provider: string | null | undefined,
  options?: { profileId?: string | null },
): string {
  const sanitizedProvider = sanitizeOAuthRefreshFailureProvider(provider);
  const sanitizedProfileId = sanitizeOAuthRefreshFailureProfileId(options?.profileId);
  return sanitizedProvider
    ? formatCliCommand(
        sanitizedProfileId
          ? `openclaw models auth login --provider ${sanitizedProvider} --profile-id ${quoteShellArg(sanitizedProfileId)}`
          : `openclaw models auth login --provider ${sanitizedProvider}`,
      )
    : formatCliCommand("openclaw models auth login");
}
