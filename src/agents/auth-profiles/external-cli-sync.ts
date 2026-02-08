import type { AuthProfileCredential, AuthProfileStore, OAuthCredential } from "./types.js";
import {
  readClaudeCliCredentialsCached,
  readQwenCliCredentialsCached,
  readMiniMaxCliCredentialsCached,
} from "../cli-credentials.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  EXTERNAL_CLI_NEAR_EXPIRY_MS,
  EXTERNAL_CLI_SYNC_TTL_MS,
  QWEN_CLI_PROFILE_ID,
  MINIMAX_CLI_PROFILE_ID,
  log,
} from "./constants.js";

function shallowEqualOAuthCredentials(a: OAuthCredential | undefined, b: OAuthCredential): boolean {
  if (!a) {
    return false;
  }
  if (a.type !== "oauth") {
    return false;
  }
  return (
    a.provider === b.provider &&
    a.access === b.access &&
    a.refresh === b.refresh &&
    a.expires === b.expires &&
    a.email === b.email &&
    a.enterpriseUrl === b.enterpriseUrl &&
    a.projectId === b.projectId &&
    a.accountId === b.accountId
  );
}

function isExternalProfileFresh(
  cred: AuthProfileCredential | undefined,
  now: number,
  provider?: string,
): boolean {
  if (!cred) {
    return false;
  }
  if (cred.type !== "oauth" && cred.type !== "token") {
    return false;
  }
  if (provider && cred.provider !== provider) {
    return false;
  }
  if (typeof cred.expires !== "number") {
    return true;
  }
  return cred.expires > now + EXTERNAL_CLI_NEAR_EXPIRY_MS;
}

/** Sync external CLI credentials into the store for a given provider. */
function syncExternalCliCredentialsForProvider(
  store: AuthProfileStore,
  profileId: string,
  provider: string,
  readCredentials: () => OAuthCredential | null,
  now: number,
): boolean {
  const existing = store.profiles[profileId];
  const shouldSync =
    !existing || existing.provider !== provider || !isExternalProfileFresh(existing, now, provider);
  const creds = shouldSync ? readCredentials() : null;
  if (!creds) {
    return false;
  }

  const existingOAuth = existing?.type === "oauth" ? existing : undefined;
  const shouldUpdate =
    !existingOAuth ||
    existingOAuth.provider !== provider ||
    existingOAuth.expires <= now ||
    creds.expires > existingOAuth.expires;

  if (shouldUpdate && !shallowEqualOAuthCredentials(existingOAuth, creds)) {
    store.profiles[profileId] = creds;
    log.info(`synced ${provider} credentials from external cli`, {
      profileId,
      expires: new Date(creds.expires).toISOString(),
    });
    return true;
  }

  return false;
}

/**
 * Sync OAuth credentials from external CLI tools (Claude Code CLI, Qwen Code CLI, MiniMax CLI)
 * into the store.
 *
 * Claude Code CLI stores full OAuth credentials (access + refresh + scopes) at
 * ~/.claude/.credentials.json. When available, these are imported as `type: "oauth"`
 * profiles so that OpenClaw can auto-refresh them when the access token expires.
 * This avoids the need to re-run onboarding when tokens expire and preserves
 * all OAuth scopes including `user:profile` (required for usage tracking).
 *
 * Returns true if any credentials were updated.
 */
export function syncExternalCliCredentials(store: AuthProfileStore): boolean {
  let mutated = false;
  const now = Date.now();

  // Sync from Claude Code CLI
  const existingClaude = store.profiles[CLAUDE_CLI_PROFILE_ID];
  const shouldSyncClaude =
    !existingClaude ||
    existingClaude.provider !== "anthropic" ||
    existingClaude.type === "token" || // Always re-check: CLI may have upgraded to OAuth
    !isExternalProfileFresh(existingClaude, now, "anthropic");
  const claudeCreds = shouldSyncClaude
    ? readClaudeCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS })
    : null;
  if (claudeCreds) {
    if (claudeCreds.type === "oauth") {
      // Full OAuth credential with refresh token — preferred path.
      const existing = store.profiles[CLAUDE_CLI_PROFILE_ID];
      const existingOAuth = existing?.type === "oauth" ? existing : undefined;
      const shouldUpdate =
        !existingOAuth ||
        existingOAuth.provider !== "anthropic" ||
        existingOAuth.expires <= now ||
        claudeCreds.expires > existingOAuth.expires;

      const oauthCred: OAuthCredential = {
        type: "oauth",
        provider: "anthropic",
        access: claudeCreds.access,
        refresh: claudeCreds.refresh,
        expires: claudeCreds.expires,
      };

      if (shouldUpdate && !shallowEqualOAuthCredentials(existingOAuth, oauthCred)) {
        store.profiles[CLAUDE_CLI_PROFILE_ID] = oauthCred;
        mutated = true;
        log.info("synced anthropic OAuth credentials from claude cli", {
          profileId: CLAUDE_CLI_PROFILE_ID,
          expires: new Date(claudeCreds.expires).toISOString(),
        });
      }
    } else if (claudeCreds.type === "token") {
      // Setup-token (no refresh) — import but warn that usage tracking won't work.
      const existing = store.profiles[CLAUDE_CLI_PROFILE_ID];
      if (!existing || existing.provider !== "anthropic") {
        store.profiles[CLAUDE_CLI_PROFILE_ID] = {
          type: "token",
          provider: "anthropic",
          token: claudeCreds.token,
          expires: claudeCreds.expires,
        };
        mutated = true;
        log.info("synced anthropic token from claude cli (setup-token, no refresh)", {
          profileId: CLAUDE_CLI_PROFILE_ID,
          expires: new Date(claudeCreds.expires).toISOString(),
        });
      }
    }
  }

  // Sync from Qwen Code CLI
  if (
    syncExternalCliCredentialsForProvider(
      store,
      QWEN_CLI_PROFILE_ID,
      "qwen-portal",
      () => readQwenCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS }),
      now,
    )
  ) {
    mutated = true;
  }

  // Sync from MiniMax Portal CLI
  if (
    syncExternalCliCredentialsForProvider(
      store,
      MINIMAX_CLI_PROFILE_ID,
      "minimax-portal",
      () => readMiniMaxCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS }),
      now,
    )
  ) {
    mutated = true;
  }

  return mutated;
}
