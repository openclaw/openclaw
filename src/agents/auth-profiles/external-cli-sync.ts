import type { AuthProfileCredential, AuthProfileStore, OAuthCredential } from "./types.js";
import {
  readQwenCliCredentialsCached,
  readMiniMaxCliCredentialsCached,
} from "../cli-credentials.js";
import {
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
  if (cred.provider !== "qwen-portal" && cred.provider !== "minimax-portal") {
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
 * Sync OAuth credentials from external CLI tools (Qwen Code CLI, MiniMax CLI) into the store.
 *
 * Returns true if any credentials were updated.
 */
export function syncExternalCliCredentials(store: AuthProfileStore): boolean {
  let mutated = false;
  const now = Date.now();

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
