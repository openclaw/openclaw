import {
  readQwenCliCredentialsCached,
  readMiniMaxCliCredentialsCached,
  readClaudeCliCredentialsCached,
  type QwenCliCredential,
  type MiniMaxCliCredential,
  type ClaudeCliCredential,
} from "../cli-credentials.js";
import {
  EXTERNAL_CLI_NEAR_EXPIRY_MS,
  EXTERNAL_CLI_SYNC_TTL_MS,
  QWEN_CLI_PROFILE_ID,
  MINIMAX_CLI_PROFILE_ID,
  log,
} from "./constants.js";
import type { AuthProfileCredential, AuthProfileStore, OAuthCredential } from "./types.js";

type SyncExternalCliDeps = {
  readQwenCliCredentialsCached?: (opts?: { ttlMs?: number }) => QwenCliCredential | null;
  readMiniMaxCliCredentialsCached?: (opts?: { ttlMs?: number }) => MiniMaxCliCredential | null;
  readClaudeCliCredentialsCached?: (opts?: {
    ttlMs?: number;
    allowKeychainPrompt?: boolean;
  }) => ClaudeCliCredential | null;
};

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

function isExternalProfileFresh(cred: AuthProfileCredential | undefined, now: number): boolean {
  if (!cred) {
    return false;
  }
  if (cred.type !== "oauth" && cred.type !== "token") {
    return false;
  }
  if (
    cred.provider !== "qwen-portal" &&
    cred.provider !== "minimax-portal" &&
    cred.provider !== "anthropic"
  ) {
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
    !existing || existing.provider !== provider || !isExternalProfileFresh(existing, now);
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
 * Sync OAuth credentials from external CLI tools (Qwen Code CLI, MiniMax CLI, Claude Code CLI) into the store.
 *
 * Returns true if any credentials were updated.
 *
 * The optional `deps` parameter allows injecting credential readers for testing.
 */
export function syncExternalCliCredentials(
  store: AuthProfileStore,
  deps?: SyncExternalCliDeps,
): boolean {
  const readQwen = deps?.readQwenCliCredentialsCached ?? readQwenCliCredentialsCached;
  const readMiniMax = deps?.readMiniMaxCliCredentialsCached ?? readMiniMaxCliCredentialsCached;
  const readClaude = deps?.readClaudeCliCredentialsCached ?? readClaudeCliCredentialsCached;

  let mutated = false;
  const now = Date.now();

  // Sync from Qwen Code CLI
  if (
    syncExternalCliCredentialsForProvider(
      store,
      QWEN_CLI_PROFILE_ID,
      "qwen-portal",
      () => readQwen({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS }),
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
      () => readMiniMax({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS }),
      now,
    )
  ) {
    mutated = true;
  }

  // Sync anthropic:default only when the profile is already oauth.
  // Never auto-convert api_key/token profiles to oauth.
  const anthropicDefaultProfileId = "anthropic:default";
  const existingAnthropicDefault = store.profiles[anthropicDefaultProfileId];
  if (
    existingAnthropicDefault &&
    existingAnthropicDefault.provider === "anthropic" &&
    existingAnthropicDefault.type === "oauth" &&
    syncExternalCliCredentialsForProvider(
      store,
      anthropicDefaultProfileId,
      "anthropic",
      () => {
        const cred = readClaude({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS });
        return cred?.type === "oauth" ? cred : null;
      },
      now,
    )
  ) {
    mutated = true;
  }

  return mutated;
}
