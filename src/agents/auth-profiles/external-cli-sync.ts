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
 * Sync OAuth credentials from external CLI tools (Claude CLI, Qwen Code CLI, MiniMax CLI) into the store.
 *
 * Returns true if any credentials were updated.
 */
export function syncExternalCliCredentials(store: AuthProfileStore): boolean {
  let mutated = false;
  const now = Date.now();

  // Sync from Claude CLI
  const existingClaude = store.profiles[CLAUDE_CLI_PROFILE_ID];
  const shouldSyncClaude =
    !existingClaude ||
    existingClaude.provider !== "anthropic" ||
    !isExternalProfileFresh(existingClaude, now);
  const claudeCreds = shouldSyncClaude
    ? readClaudeCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS })
    : null;
  if (claudeCreds) {
    const existing = store.profiles[CLAUDE_CLI_PROFILE_ID];
    if (claudeCreds.type === "oauth") {
      const existingOAuth = existing?.type === "oauth" ? existing : undefined;
      const shouldUpdate =
        !existingOAuth ||
        existingOAuth.provider !== "anthropic" ||
        existingOAuth.expires <= now ||
        claudeCreds.expires > existingOAuth.expires;

      if (shouldUpdate && !shallowEqualOAuthCredentials(existingOAuth, claudeCreds)) {
        store.profiles[CLAUDE_CLI_PROFILE_ID] = claudeCreds;
        mutated = true;
        log.info("synced anthropic credentials from claude cli", {
          profileId: CLAUDE_CLI_PROFILE_ID,
          expires: new Date(claudeCreds.expires).toISOString(),
        });
      }
    } else if (claudeCreds.type === "token") {
      const existingToken = existing?.type === "token" ? existing : undefined;
      const shouldUpdate =
        !existingToken ||
        existingToken.provider !== "anthropic" ||
        (typeof existingToken.expires === "number" && existingToken.expires <= now) ||
        (typeof claudeCreds.expires === "number" &&
          (!existingToken.expires || claudeCreds.expires > existingToken.expires));

      if (shouldUpdate) {
        store.profiles[CLAUDE_CLI_PROFILE_ID] = claudeCreds;
        mutated = true;
        log.info("synced anthropic token from claude cli", {
          profileId: CLAUDE_CLI_PROFILE_ID,
          expires:
            typeof claudeCreds.expires === "number"
              ? new Date(claudeCreds.expires).toISOString()
              : "none",
        });
      }
    }
  }

  // Sync from Qwen Code CLI
  const existingQwen = store.profiles[QWEN_CLI_PROFILE_ID];
  const shouldSyncQwen =
    !existingQwen ||
    existingQwen.provider !== "qwen-portal" ||
    !isExternalProfileFresh(existingQwen, now);
  const qwenCreds = shouldSyncQwen
    ? readQwenCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS })
    : null;
  if (qwenCreds) {
    const existing = store.profiles[QWEN_CLI_PROFILE_ID];
    const existingOAuth = existing?.type === "oauth" ? existing : undefined;
    const shouldUpdate =
      !existingOAuth ||
      existingOAuth.provider !== "qwen-portal" ||
      existingOAuth.expires <= now ||
      qwenCreds.expires > existingOAuth.expires;

    if (shouldUpdate && !shallowEqualOAuthCredentials(existingOAuth, qwenCreds)) {
      store.profiles[QWEN_CLI_PROFILE_ID] = qwenCreds;
      mutated = true;
      log.info("synced qwen credentials from qwen cli", {
        profileId: QWEN_CLI_PROFILE_ID,
        expires: new Date(qwenCreds.expires).toISOString(),
      });
    }
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

/**
 * Force re-sync credentials for an external CLI profile after an auth error (e.g. 403 revoked).
 * Bypasses the TTL cache to get the latest credentials from the CLI tool.
 * Returns true if different, still-valid credentials were applied to the in-memory store.
 * Caller is responsible for persisting the store to disk.
 */
export function resyncExternalCliOnAuthError(store: AuthProfileStore, profileId: string): boolean {
  const now = Date.now();

  if (profileId === CLAUDE_CLI_PROFILE_ID) {
    const creds = readClaudeCliCredentialsCached({ ttlMs: 0 });
    if (!creds) {
      return false;
    }
    const existing = store.profiles[profileId];

    if (creds.type === "oauth") {
      const existingOAuth = existing?.type === "oauth" ? existing : undefined;
      if (existingOAuth && shallowEqualOAuthCredentials(existingOAuth, creds)) {
        return false;
      }
      if (creds.expires <= now) {
        return false;
      }
      store.profiles[profileId] = creds;
      log.info("re-synced anthropic credentials from claude cli after auth error", {
        profileId,
        expires: new Date(creds.expires).toISOString(),
      });
      return true;
    }

    if (creds.type === "token") {
      const existingToken = existing?.type === "token" ? existing : undefined;
      if (existingToken?.token === creds.token && existingToken.expires === creds.expires) {
        return false;
      }
      if (typeof creds.expires === "number" && creds.expires <= now) {
        return false;
      }
      store.profiles[profileId] = creds;
      log.info("re-synced anthropic token from claude cli after auth error", {
        profileId,
      });
      return true;
    }
    return false;
  }

  if (profileId === QWEN_CLI_PROFILE_ID) {
    const creds = readQwenCliCredentialsCached({ ttlMs: 0 });
    if (!creds) {
      return false;
    }
    const existing = store.profiles[profileId];
    const existingOAuth = existing?.type === "oauth" ? existing : undefined;
    if (existingOAuth && shallowEqualOAuthCredentials(existingOAuth, creds)) {
      return false;
    }
    if (creds.expires <= now) {
      return false;
    }
    store.profiles[profileId] = creds;
    log.info("re-synced qwen credentials from qwen cli after auth error", {
      profileId,
      expires: new Date(creds.expires).toISOString(),
    });
    return true;
  }

  if (profileId === MINIMAX_CLI_PROFILE_ID) {
    const creds = readMiniMaxCliCredentialsCached({ ttlMs: 0 });
    if (!creds) {
      return false;
    }
    const existing = store.profiles[profileId];
    const existingOAuth = existing?.type === "oauth" ? existing : undefined;
    if (existingOAuth && shallowEqualOAuthCredentials(existingOAuth, creds)) {
      return false;
    }
    if (creds.expires <= now) {
      return false;
    }
    store.profiles[profileId] = creds;
    log.info("re-synced minimax credentials from minimax cli after auth error", {
      profileId,
      expires: new Date(creds.expires).toISOString(),
    });
    return true;
  }

  return false;
}
