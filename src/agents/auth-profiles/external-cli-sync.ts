/** MiniMax CLI bootstrap and persisted ownership; provider plugins own other external auth. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveRequiredOsHomeDir } from "../../infra/home-dir.js";
import { readMiniMaxCliCredentialsCached } from "../cli-credentials.js";
import { EXTERNAL_CLI_SYNC_TTL_MS, MINIMAX_CLI_PROFILE_ID, authProfilesLog } from "./constants.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import { isOAuthRefreshFence } from "./oauth-refresh-marker.js";
import {
  isSafeToAdoptBootstrapOAuthIdentity,
  type RuntimeExternalOAuthProfile,
} from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

type ExternalCliAuthProfileOptions = {
  allowKeychainPrompt?: boolean;
  env?: NodeJS.ProcessEnv;
  providerIds?: Iterable<string>;
  profileIds?: Iterable<string>;
};

type PersistedExternalCliAuthProfile = RuntimeExternalOAuthProfile & { persistence: "persisted" };

const PERSISTED_EXTERNAL_CLI_AUTH_FLOW = "external-cli";
const MINIMAX_PROVIDER = "minimax-portal";
const MINIMAX_PROVIDER_IDS = [MINIMAX_PROVIDER, "minimax", "minimax-cli"];

function isMiniMaxCliProfile(params: { profileId: string; credential?: OAuthCredential }): boolean {
  return (
    params.profileId === MINIMAX_CLI_PROFILE_ID &&
    (!params.credential || MINIMAX_PROVIDER_IDS.includes(params.credential.provider))
  );
}

function readMiniMaxCredential(env?: NodeJS.ProcessEnv, provider?: string): OAuthCredential | null {
  const credential = readMiniMaxCliCredentialsCached({
    ttlMs: EXTERNAL_CLI_SYNC_TTL_MS,
    ...(env ? { homeDir: resolveRequiredOsHomeDir(env) } : {}),
  });
  return credential && provider !== undefined ? { ...credential, provider } : credential;
}

/** True when durable metadata assigns this stored profile to an external CLI owner. */
export function isPersistedExternalCliAuthProfile(params: {
  profileId: string;
  credential: OAuthCredential;
}): boolean {
  if (!isMiniMaxCliProfile(params)) {
    return false;
  }
  // Historical native MiniMax logins and CLI imports share an unmarked shape.
  // Only exact CLI token backfill may assign durable external ownership.
  return params.credential.authFlow === PERSISTED_EXTERNAL_CLI_AUTH_FLOW;
}

function markPersistedExternalCliCredential(credential: OAuthCredential): OAuthCredential {
  return { ...credential, authFlow: PERSISTED_EXTERNAL_CLI_AUTH_FLOW };
}

/** Provider ids whose external CLI credentials can be refreshed by this owner. */
export function listExternalCliSyncProviderIds(): string[] {
  return [...MINIMAX_PROVIDER_IDS];
}

/** Read a CLI credential only for safe bootstrap of an unusable local profile. */
export function readExternalCliBootstrapCredential(params: {
  profileId: string;
  credential: OAuthCredential;
}): OAuthCredential | null {
  if (!isMiniMaxCliProfile(params)) {
    return null;
  }
  const imported = readMiniMaxCredential(undefined, params.credential.provider);
  if (imported && isOAuthRefreshFence(params.credential)) {
    // An external snapshot has no generation ordering proof. It must not clear
    // a fence and make an older single-use refresh token replayable.
    return null;
  }
  return imported;
}

function normalizeProviderScope(values: Iterable<string> | undefined): Set<string> | undefined {
  return values === undefined
    ? undefined
    : new Set(Array.from(values, normalizeProviderId).filter(Boolean));
}

function isMiniMaxCliInScope(params: {
  store: AuthProfileStore;
  options?: ExternalCliAuthProfileOptions;
}): boolean {
  const { options, store } = params;
  const providerScope = normalizeProviderScope(options?.providerIds);
  if (providerScope === undefined && options?.profileIds === undefined) {
    const existing = store.profiles[MINIMAX_CLI_PROFILE_ID];
    return (
      Object.hasOwn(store.profiles, MINIMAX_CLI_PROFILE_ID) &&
      existing?.type === "oauth" &&
      MINIMAX_PROVIDER_IDS.includes(existing.provider)
    );
  }
  if (
    Array.from(options?.profileIds ?? []).some(
      (profileId) => MINIMAX_CLI_PROFILE_ID === profileId.trim(),
    )
  ) {
    return true;
  }
  return MINIMAX_PROVIDER_IDS.some((alias) => providerScope?.has(alias));
}

/** True when the built-in CLI owns a refreshable profile slot. */
export function isExternalCliAuthProfileInScope(params: {
  store: AuthProfileStore;
  profileId: string;
}): boolean {
  return (
    params.profileId === MINIMAX_CLI_PROFILE_ID && isMiniMaxCliInScope({ store: params.store })
  );
}

function backfillExternalCliIdentity(params: {
  existingOAuth: OAuthCredential;
  env?: NodeJS.ProcessEnv;
}): OAuthCredential | null {
  const creds = readMiniMaxCredential(params.env);
  // Matching token material proves the stored profile came from this CLI owner.
  // Persist that fact so refresh ownership does not depend on a later file read.
  const sameLogin = creds?.refresh === params.existingOAuth.refresh;
  if (!sameLogin) {
    return null;
  }
  const credential = markPersistedExternalCliCredential({
    ...params.existingOAuth,
    ...(params.existingOAuth.email || !creds.email ? {} : { email: creds.email }),
  });
  return credential.authFlow === params.existingOAuth.authFlow &&
    credential.email === params.existingOAuth.email
    ? null
    : credential;
}

/** Resolve scoped external CLI auth profiles available to overlay or persist. */
export function resolveExternalCliAuthProfiles(
  store: AuthProfileStore,
  options?: ExternalCliAuthProfileOptions,
): PersistedExternalCliAuthProfile[] {
  const now = Date.now();
  if (!isMiniMaxCliInScope({ store, options })) {
    return [];
  }
  const profileId = MINIMAX_CLI_PROFILE_ID;
  const existing = store.profiles[profileId];
  const existingOAuth =
    existing?.type === "oauth" && MINIMAX_PROVIDER_IDS.includes(existing.provider)
      ? existing
      : undefined;
  if (existing && !existingOAuth) {
    authProfilesLog.debug("kept explicit local auth over external cli bootstrap", {
      profileId,
      provider: MINIMAX_PROVIDER,
      localType: existing.type,
      localProvider: existing.provider,
    });
    return [];
  }
  if (existingOAuth && hasUsableOAuthCredential(existingOAuth, { now })) {
    // Profiles synced before identity capture carry no email; backfill the
    // non-secret metadata once the CLI read proves it is the same login.
    const backfilled = backfillExternalCliIdentity({
      existingOAuth,
      env: options?.env,
    });
    return backfilled
      ? [
          {
            profileId,
            credential: backfilled,
            persistence: "persisted",
          },
        ]
      : [];
  }
  const creds = readMiniMaxCredential(options?.env, existingOAuth?.provider ?? MINIMAX_PROVIDER);
  if (!creds) {
    return [];
  }
  if (existingOAuth && isOAuthRefreshFence(existingOAuth)) {
    authProfilesLog.warn("refused unordered external cli oauth recovery for a fenced profile", {
      profileId,
      provider: MINIMAX_PROVIDER,
    });
    return [];
  }
  if (existingOAuth && !isSafeToAdoptBootstrapOAuthIdentity(existingOAuth, creds)) {
    authProfilesLog.warn("refused external cli oauth bootstrap: identity mismatch", {
      profileId,
      provider: MINIMAX_PROVIDER,
    });
    return [];
  }
  if (!hasUsableOAuthCredential(creds, { now })) {
    return [];
  }
  authProfilesLog.debug(
    "used external cli oauth bootstrap because local oauth was missing or unusable",
    {
      profileId,
      provider: MINIMAX_PROVIDER,
      localExpires: existingOAuth?.expires,
      externalExpires: creds.expires,
    },
  );
  return [
    {
      profileId,
      credential: markPersistedExternalCliCredential(creds),
      persistence: "persisted",
    },
  ];
}
