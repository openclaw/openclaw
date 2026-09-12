import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const CODEX_EXTERNAL_AUTH_REAUTH_REQUIRED_ERROR_CODE = -32_090;
export const CODEX_EXTERNAL_AUTH_REAUTH_REQUIRED_RESPONSE_MESSAGE =
  "OAuth reauthentication required";

// Codex drops callback messages because they may contain tokens, but preserves
// this numeric code in its sanitized terminal error.
const CODEX_EXTERNAL_AUTH_REAUTH_REQUIRED_MESSAGE = `auth refresh request failed: code=${CODEX_EXTERNAL_AUTH_REAUTH_REQUIRED_ERROR_CODE}`;
const OPENAI_REAUTH_REQUIRED_RAW_ERROR = "OAuth token refresh failed for openai: sign_in_again";

const PERMANENT_OPENAI_OAUTH_REASONS = new Set([
  "expired",
  "invalid_grant",
  "invalid_refresh_token",
  "refresh_token_reused",
  "revoked",
  "token_invalidated",
]);

export function isPermanentOpenAIOAuthRefreshFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "OAuthRefreshFailureError") {
    return false;
  }
  const failure = asOptionalRecord(error);
  const reason = failure?.reason;
  return (
    failure?.provider === "openai" &&
    typeof reason === "string" &&
    PERMANENT_OPENAI_OAUTH_REASONS.has(reason)
  );
}

export function readCodexExternalAuthReauthFailure(
  message: string | null | undefined,
): Error | undefined {
  if (message !== CODEX_EXTERNAL_AUTH_REAUTH_REQUIRED_MESSAGE) {
    return undefined;
  }
  return Object.assign(new Error(CODEX_EXTERNAL_AUTH_REAUTH_REQUIRED_RESPONSE_MESSAGE), {
    rawError: OPENAI_REAUTH_REQUIRED_RAW_ERROR,
  });
}
