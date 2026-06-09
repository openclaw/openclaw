/**
 * External CLI OAuth synchronization.
 * Reads supported CLI credential stores, decides whether those credentials can
 * safely bootstrap local auth profiles, and returns runtime/persisted overlays.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
  readMiniMaxCliCredentialsCached,
} from "../cli-credentials.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  EXTERNAL_CLI_SYNC_TTL_MS,
  MINIMAX_CLI_PROFILE_ID,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
} from "./constants.js";
import { log } from "./constants.js";
import {
  areOAuthCredentialsEquivalent,
  hasUsableOAuthCredential,
  isSafeToAdoptBootstrapOAuthIdentity,
  shouldBootstrapFromExternalCliCredential,
} from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

export {
  areOAuthCredentialsEquivalent,
  hasUsableOAuthCredential,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToOverwriteStoredOAuthIdentity,
  shouldBootstrapFromExternalCliCredential,
  shouldReplaceStoredOAuthCredential,
} from "./oauth-shared.js";

export type ExternalCliResolvedProfile = {
  profileId: string;
  credential: OAuthCredential;
  persistence?: "runtime-only" | "persisted";
};

export type ExternalCliAuthSyncDiagnosticStatus =
  | "synced"
  | "local_kept"
  | "local_stale"
  | "external_stale"
  | "account_mismatch"
  | "missing_identity_binding";

export type ExternalCliAuthSyncDiagnostic = {
  profileId: string;
  provider: string;
  externalProvider: string;
  status: ExternalCliAuthSyncDiagnosticStatus;
  persistence?: "runtime-only" | "persisted";
  localExpires?: number;
  externalExpires?: number;
  message: string;
  action: string;
};

export type ExternalCliAuthProfileOptions = {
  allowKeychainPrompt?: boolean;
  providerIds?: Iterable<string>;
  profileIds?: Iterable<string>;
};

type ExternalCliSyncProvider = {
  profileId: string;
  profileAliases?: readonly string[];
  provider: string;
  aliases?: readonly string[];
  readCredentials: (
    options?: Pick<ExternalCliAuthProfileOptions, "allowKeychainPrompt">,
  ) => OAuthCredential | null;
  // bootstrapOnly providers adopt the external CLI credential only to
  // seed an empty slot; once a local OAuth credential exists for the
  // profile, the local refresh token is treated as canonical and the
  // CLI state must not replace or shadow it. Codex requires this to
  // avoid clobbering a locally refreshed token with stale CLI state.
  bootstrapOnly?: boolean;
};

function normalizeAuthIdentityToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeAuthEmailToken(value: string | undefined): string | undefined {
  return normalizeAuthIdentityToken(value)?.toLowerCase();
}

// Keep this gate aligned with the canonical identity-copy rule in oauth.ts.
/** Return true when imported CLI credentials match an existing profile identity. */
export function isSafeToUseExternalCliCredential(
  existing: OAuthCredential | undefined,
  imported: OAuthCredential,
): boolean {
  if (!existing) {
    return true;
  }
  if (existing.provider !== imported.provider) {
    return false;
  }

  const existingAccountId = normalizeAuthIdentityToken(existing.accountId);
  const importedAccountId = normalizeAuthIdentityToken(imported.accountId);
  const existingEmail = normalizeAuthEmailToken(existing.email);
  const importedEmail = normalizeAuthEmailToken(imported.email);

  if (existingAccountId !== undefined && importedAccountId !== undefined) {
    return existingAccountId === importedAccountId;
  }
  if (existingEmail !== undefined && importedEmail !== undefined) {
    return existingEmail === importedEmail;
  }

  const existingHasIdentity = existingAccountId !== undefined || existingEmail !== undefined;
  if (existingHasIdentity) {
    return false;
  }
  return true;
}

const EXTERNAL_CLI_SYNC_PROVIDERS: ExternalCliSyncProvider[] = [
  {
    profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
    profileAliases: ["openai:default"],
    provider: "openai",
    aliases: ["openai", "codex", "codex-cli", "codex-app-server"],
    readCredentials: (options) =>
      readCodexCliCredentialsCached({
        ttlMs: EXTERNAL_CLI_SYNC_TTL_MS,
        allowKeychainPrompt: options?.allowKeychainPrompt,
      }),
    bootstrapOnly: true,
  },
  {
    profileId: CLAUDE_CLI_PROFILE_ID,
    provider: "claude-cli",
    readCredentials: (options) => {
      const credential = readClaudeCliCredentialsCached({
        ttlMs: EXTERNAL_CLI_SYNC_TTL_MS,
        allowKeychainPrompt: options?.allowKeychainPrompt,
      });
      if (credential?.type !== "oauth") {
        return null;
      }
      return { ...credential, provider: "claude-cli" };
    },
  },
  {
    profileId: MINIMAX_CLI_PROFILE_ID,
    provider: "minimax-portal",
    aliases: ["minimax", "minimax-cli"],
    readCredentials: () => readMiniMaxCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS }),
  },
];

function resolveExternalCliSyncProvider(params: {
  profileId: string;
  credential?: OAuthCredential;
}): ExternalCliSyncProvider | null {
  const provider = EXTERNAL_CLI_SYNC_PROVIDERS.find((entry) =>
    externalCliProfileIdMatches(entry, params.profileId),
  );
  if (!provider) {
    return null;
  }
  if (
    params.credential &&
    !listExternalCliProviderIds(provider).includes(params.credential.provider)
  ) {
    return null;
  }
  return provider;
}

function listExternalCliProfileIds(providerConfig: ExternalCliSyncProvider): string[] {
  return [providerConfig.profileId, ...(providerConfig.profileAliases ?? [])];
}

function listExternalCliProviderIds(providerConfig: ExternalCliSyncProvider): string[] {
  return [providerConfig.provider, ...(providerConfig.aliases ?? [])];
}

function normalizeExternalCliCredentialProvider(
  credential: OAuthCredential | null,
  provider: string,
): OAuthCredential | null {
  return credential ? { ...credential, provider } : null;
}

function getAuthProfileProviderPrefix(profileId: string): string {
  return profileId.split(":", 1)[0]?.trim() ?? "";
}

function externalCliProfileIdMatches(
  providerConfig: ExternalCliSyncProvider,
  profileId: string,
  options?: { allowLegacyNamespace?: boolean },
): boolean {
  if (listExternalCliProfileIds(providerConfig).includes(profileId)) {
    return true;
  }
  if (
    !options?.allowLegacyNamespace ||
    providerConfig.profileId !== OPENAI_CODEX_DEFAULT_PROFILE_ID
  ) {
    return false;
  }
  const normalizedPrefix = normalizeProviderId(getAuthProfileProviderPrefix(profileId));
  return normalizedPrefix === "openai";
}

function hasInlineOAuthTokenMaterial(credential: OAuthCredential): boolean {
  return [credential.access, credential.refresh, credential.idToken].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

function buildAuthLoginAction(provider: string): string {
  return `Run \`openclaw models auth login --provider ${provider}\` to refresh the local profile.`;
}

function externalCliLabel(provider: ExternalCliSyncProvider): string {
  if (provider.profileId === OPENAI_CODEX_DEFAULT_PROFILE_ID) {
    return "Codex CLI";
  }
  if (provider.profileId === CLAUDE_CLI_PROFILE_ID) {
    return "Claude CLI";
  }
  if (provider.profileId === MINIMAX_CLI_PROFILE_ID) {
    return "MiniMax CLI";
  }
  return `${provider.provider} CLI`;
}

/** Read a CLI credential only for safe bootstrap of an unusable local profile. */
export function readExternalCliBootstrapCredential(params: {
  profileId: string;
  credential: OAuthCredential;
  allowInlineOAuthTokenMaterial?: boolean;
  allowKeychainPrompt?: boolean;
}): OAuthCredential | null {
  const provider = resolveExternalCliSyncProvider(params);
  if (!provider) {
    return null;
  }
  if (
    provider.bootstrapOnly &&
    !params.allowInlineOAuthTokenMaterial &&
    hasInlineOAuthTokenMaterial(params.credential)
  ) {
    return null;
  }
  return normalizeExternalCliCredentialProvider(
    provider.readCredentials({ allowKeychainPrompt: params.allowKeychainPrompt }),
    params.credential.provider,
  );
}

export const readManagedExternalCliCredential = readExternalCliBootstrapCredential;

/** Explain how an external CLI credential would be used for a stored profile. */
export function diagnoseExternalCliAuthProfileSync(params: {
  profileId: string;
  credential: OAuthCredential;
  allowKeychainPrompt?: boolean;
}): ExternalCliAuthSyncDiagnostic | null {
  const providerConfig = resolveExternalCliSyncProvider(params);
  if (!providerConfig) {
    return null;
  }

  const label = externalCliLabel(providerConfig);
  const action = buildAuthLoginAction(params.credential.provider);
  if (
    providerConfig.bootstrapOnly &&
    hasInlineOAuthTokenMaterial(params.credential) &&
    !hasUsableOAuthCredential(params.credential)
  ) {
    const external = normalizeExternalCliCredentialProvider(
      providerConfig.readCredentials({ allowKeychainPrompt: params.allowKeychainPrompt }),
      params.credential.provider,
    );
    if (!external) {
      return {
        profileId: params.profileId,
        provider: params.credential.provider,
        externalProvider: providerConfig.provider,
        status: "local_stale",
        persistence: "runtime-only",
        localExpires: params.credential.expires,
        message: `${label} sync skipped because the local OAuth profile owns stale token material.`,
        action,
      };
    }
    if (!hasUsableOAuthCredential(external)) {
      return {
        profileId: params.profileId,
        provider: params.credential.provider,
        externalProvider: providerConfig.provider,
        status: "external_stale",
        persistence: "runtime-only",
        localExpires: params.credential.expires,
        externalExpires: external.expires,
        message: `${label} credentials are also stale or near expiry.`,
        action,
      };
    }
    if (!isSafeToUseExternalCliCredential(params.credential, external)) {
      return {
        profileId: params.profileId,
        provider: params.credential.provider,
        externalProvider: providerConfig.provider,
        status: "account_mismatch",
        persistence: "runtime-only",
        localExpires: params.credential.expires,
        externalExpires: external.expires,
        message: `${label} account does not match the local OAuth profile.`,
        action,
      };
    }
    return {
      profileId: params.profileId,
      provider: params.credential.provider,
      externalProvider: providerConfig.provider,
      status: "local_stale",
      persistence: "runtime-only",
      localExpires: params.credential.expires,
      externalExpires: external.expires,
      message: `${label} has usable credentials, but this local profile must be refreshed directly.`,
      action,
    };
  }

  const external = normalizeExternalCliCredentialProvider(
    providerConfig.readCredentials({ allowKeychainPrompt: params.allowKeychainPrompt }),
    params.credential.provider,
  );
  if (!external) {
    return null;
  }
  const persistence = providerConfig.bootstrapOnly ? "runtime-only" : "persisted";
  if (!hasUsableOAuthCredential(external)) {
    return {
      profileId: params.profileId,
      provider: params.credential.provider,
      externalProvider: providerConfig.provider,
      status: "external_stale",
      persistence,
      localExpires: params.credential.expires,
      externalExpires: external.expires,
      message: `${label} credentials are stale or near expiry.`,
      action,
    };
  }
  if (!isSafeToUseExternalCliCredential(params.credential, external)) {
    return {
      profileId: params.profileId,
      provider: params.credential.provider,
      externalProvider: providerConfig.provider,
      status: "account_mismatch",
      persistence,
      localExpires: params.credential.expires,
      externalExpires: external.expires,
      message: `${label} account does not match the local OAuth profile.`,
      action,
    };
  }
  if (
    !isSafeToAdoptBootstrapOAuthIdentity(params.credential, external) &&
    !areOAuthCredentialsEquivalent(params.credential, external)
  ) {
    return {
      profileId: params.profileId,
      provider: params.credential.provider,
      externalProvider: providerConfig.provider,
      status: "missing_identity_binding",
      persistence,
      localExpires: params.credential.expires,
      externalExpires: external.expires,
      message: `${label} cannot be adopted because the local profile is missing a matching identity binding.`,
      action,
    };
  }
  if (
    shouldBootstrapFromExternalCliCredential({
      existing: params.credential,
      imported: external,
    })
  ) {
    return {
      profileId: params.profileId,
      provider: params.credential.provider,
      externalProvider: providerConfig.provider,
      status: "synced",
      persistence,
      localExpires: params.credential.expires,
      externalExpires: external.expires,
      message:
        persistence === "runtime-only"
          ? `${label} credentials are being used at runtime for this profile.`
          : `${label} credentials are eligible to sync into this profile.`,
      action:
        persistence === "runtime-only"
          ? `${action} This keeps future refreshes owned by OpenClaw.`
          : "No action needed.",
    };
  }
  if (hasUsableOAuthCredential(params.credential)) {
    return {
      profileId: params.profileId,
      provider: params.credential.provider,
      externalProvider: providerConfig.provider,
      status: "local_kept",
      persistence,
      localExpires: params.credential.expires,
      externalExpires: external.expires,
      message: `Local OAuth profile is usable; ${label} credentials were not needed.`,
      action: "No action needed.",
    };
  }
  return null;
}

/** Read a CLI credential as a fallback for refresh/runtime auth recovery. */
export function readExternalCliFallbackCredential(params: {
  profileId: string;
  credential: OAuthCredential;
  allowKeychainPrompt?: boolean;
}): OAuthCredential | null {
  const provider =
    resolveExternalCliSyncProvider(params) ??
    EXTERNAL_CLI_SYNC_PROVIDERS.find((entry) =>
      listExternalCliProviderIds(entry).includes(params.credential.provider),
    );
  if (!provider) {
    return null;
  }
  return normalizeExternalCliCredentialProvider(
    provider.readCredentials({ allowKeychainPrompt: params.allowKeychainPrompt }),
    params.credential.provider,
  );
}

function normalizeProviderScope(values: Iterable<string> | undefined): Set<string> | undefined {
  if (values === undefined) {
    return undefined;
  }
  const out = new Set<string>();
  for (const value of values) {
    const raw = value.trim();
    if (!raw) {
      continue;
    }
    out.add(raw.toLowerCase());
    const normalized = normalizeProviderId(raw);
    if (normalized) {
      out.add(normalized);
    }
  }
  return out;
}

function isExternalCliProviderInScope(params: {
  providerConfig: ExternalCliSyncProvider;
  store: AuthProfileStore;
  options?: ExternalCliAuthProfileOptions;
}): boolean {
  const { providerConfig, options, store } = params;
  const providerScope = normalizeProviderScope(options?.providerIds);
  if (providerScope === undefined && options?.profileIds === undefined) {
    return Object.entries(store.profiles).some(([profileId, existing]) => {
      return (
        externalCliProfileIdMatches(providerConfig, profileId) &&
        existing?.type === "oauth" &&
        listExternalCliProviderIds(providerConfig).includes(existing.provider)
      );
    });
  }
  if (
    Array.from(options?.profileIds ?? []).some((profileId) =>
      externalCliProfileIdMatches(providerConfig, profileId.trim(), {
        allowLegacyNamespace: true,
      }),
    )
  ) {
    return true;
  }
  if (!providerScope || providerScope.size === 0) {
    return false;
  }
  return listExternalCliProviderIds(providerConfig).some((alias) => {
    const raw = alias.trim().toLowerCase();
    const normalized = normalizeProviderId(alias);
    return providerScope.has(raw) || (normalized ? providerScope.has(normalized) : false);
  });
}

function listScopedExternalCliProfileIds(params: {
  providerConfig: ExternalCliSyncProvider;
  store: AuthProfileStore;
  options?: ExternalCliAuthProfileOptions;
}): string[] {
  const { options, providerConfig, store } = params;
  const requestedProfileIds = Array.from(options?.profileIds ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (requestedProfileIds.length > 0) {
    return requestedProfileIds.filter((profileId) =>
      externalCliProfileIdMatches(providerConfig, profileId, {
        allowLegacyNamespace: true,
      }),
    );
  }

  const existingProfileIds = Object.keys(store.profiles).filter((profileId) =>
    externalCliProfileIdMatches(providerConfig, profileId),
  );
  if (existingProfileIds.length > 0) {
    return existingProfileIds;
  }

  return options?.providerIds ? [providerConfig.profileId] : [];
}

/** Resolve scoped external CLI auth profiles available to overlay or persist. */
export function resolveExternalCliAuthProfiles(
  store: AuthProfileStore,
  options?: ExternalCliAuthProfileOptions,
): ExternalCliResolvedProfile[] {
  const profiles: ExternalCliResolvedProfile[] = [];
  const now = Date.now();
  for (const providerConfig of EXTERNAL_CLI_SYNC_PROVIDERS) {
    if (!isExternalCliProviderInScope({ providerConfig, store, options })) {
      continue;
    }
    const scopedProfileIds = listScopedExternalCliProfileIds({
      providerConfig,
      store,
      options,
    });
    for (const profileId of scopedProfileIds) {
      const existing = store.profiles[profileId];
      const existingOAuth =
        existing?.type === "oauth" &&
        listExternalCliProviderIds(providerConfig).includes(existing.provider)
          ? existing
          : undefined;
      if (existing && !existingOAuth) {
        log.debug("kept explicit local auth over external cli bootstrap", {
          profileId,
          provider: providerConfig.provider,
          localType: existing.type,
          localProvider: existing.provider,
        });
        continue;
      }
      if (
        providerConfig.bootstrapOnly &&
        existingOAuth &&
        hasInlineOAuthTokenMaterial(existingOAuth)
      ) {
        log.debug("kept local oauth over external cli bootstrap-only provider", {
          profileId,
          provider: providerConfig.provider,
        });
        continue;
      }
      if (
        existingOAuth &&
        !providerConfig.bootstrapOnly &&
        hasUsableOAuthCredential(existingOAuth, now)
      ) {
        continue;
      }
      const creds = normalizeExternalCliCredentialProvider(
        providerConfig.readCredentials({
          allowKeychainPrompt: options?.allowKeychainPrompt,
        }),
        existingOAuth?.provider ?? providerConfig.provider,
      );
      if (!creds) {
        continue;
      }
      if (existingOAuth && !isSafeToUseExternalCliCredential(existingOAuth, creds)) {
        log.warn("refused external cli oauth bootstrap: identity mismatch", {
          profileId,
          provider: providerConfig.provider,
        });
        continue;
      }
      if (
        existingOAuth &&
        !isSafeToAdoptBootstrapOAuthIdentity(existingOAuth, creds) &&
        !areOAuthCredentialsEquivalent(existingOAuth, creds)
      ) {
        log.warn("refused external cli oauth bootstrap: identity mismatch or missing binding", {
          profileId,
          provider: providerConfig.provider,
        });
        continue;
      }
      if (
        !shouldBootstrapFromExternalCliCredential({
          existing: existingOAuth,
          imported: creds,
          now,
        })
      ) {
        if (existingOAuth) {
          log.debug("kept usable local oauth over external cli bootstrap", {
            profileId,
            provider: providerConfig.provider,
            localExpires: existingOAuth.expires,
            externalExpires: creds.expires,
          });
        }
        continue;
      }
      log.debug("used external cli oauth bootstrap because local oauth was missing or unusable", {
        profileId,
        provider: providerConfig.provider,
        localExpires: existingOAuth?.expires,
        externalExpires: creds.expires,
      });
      profiles.push({
        profileId,
        credential: creds,
        persistence: providerConfig.bootstrapOnly ? "runtime-only" : "persisted",
      });
    }
  }
  return profiles;
}
