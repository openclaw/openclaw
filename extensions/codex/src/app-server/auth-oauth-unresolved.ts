import type { AuthProfileCredential } from "openclaw/plugin-sdk/agent-runtime";
import { isFailedOAuthRefreshFence } from "openclaw/plugin-sdk/provider-oauth-runtime";
import { CodexAppServerAuthProfileUnavailableError } from "./auth-profile-recovery.js";

/** A terminally failed refresh needs a fresh sign-in; retrying could replay a consumed refresh token. */
export function unresolvedCodexOAuthError(
  profileId: string,
  stored: ReadonlyArray<AuthProfileCredential | undefined>,
): CodexAppServerAuthProfileUnavailableError {
  const label = `Codex app-server auth profile "${profileId}"`;
  return new CodexAppServerAuthProfileUnavailableError(
    stored.some((entry) => entry?.type === "oauth" && isFailedOAuthRefreshFence(entry))
      ? `${label} could not refresh its OpenAI sign-in. Sign in again from Models, then retry.`
      : `${label} could not resolve usable OAuth credentials from its OpenClaw credential store. Run "openclaw doctor" to inspect credential ownership, or select an existing OpenAI profile.`,
  );
}
