/**
 * Auth profile health summarization.
 * Classifies stored and runtime credentials into profile/provider rollups for
 * status commands and doctor output without prompting keychain access.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeSecretInputString } from "../config/types.secrets.js";
import {
  DEFAULT_OAUTH_REFRESH_MARGIN_MS,
  type AuthCredentialReasonCode,
  evaluateStoredCredentialEligibility,
  resolveTokenExpiryState,
} from "./auth-profiles/credential-state.js";
import { resolveAuthProfileDisplayLabel } from "./auth-profiles/display.js";
import { resolveEffectiveOAuthCredential } from "./auth-profiles/effective-oauth.js";
import { resolveExplicitAuthOrderSelection } from "./auth-profiles/explicit-order.js";
import { resolveAuthProfileOrder } from "./auth-profiles/order.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles/types.js";
import {
  type ProviderAuthAliasLookupParams,
  resolveProviderIdForAuth,
} from "./provider-auth-aliases.js";

export type AuthProfileHealthStatus = "ok" | "expiring" | "expired" | "missing" | "static";

type AuthProfileHealth = {
  profileId: string;
  provider: string;
  type: "oauth" | "token" | "api_key";
  status: AuthProfileHealthStatus;
  reasonCode?: AuthCredentialReasonCode;
  expiresAt?: number;
  remainingMs?: number;
  source: "store";
  label: string;
};

export type AuthProviderHealthStatus = AuthProfileHealthStatus;

export type AuthProviderHealth = {
  provider: string;
  status: AuthProviderHealthStatus;
  expiresAt?: number;
  remainingMs?: number;
  /**
   * Full credential inventory stays in `profiles`; provider rollups use this
   * effective subset after auth order, aliases, and explicit exclusions apply.
   */
  effectiveProfiles?: AuthProfileHealth[];
  profiles: AuthProfileHealth[];
};

export type AuthHealthSummary = {
  now: number;
  warnAfterMs: number;
  profiles: AuthProfileHealth[];
  providers: AuthProviderHealth[];
};

export const DEFAULT_OAUTH_WARN_MS = 24 * 60 * 60 * 1000;

/** Format a remaining-duration value for compact auth status displays. */
export function formatRemainingShort(
  remainingMs?: number,
  opts?: {
    underMinuteLabel?: string;
  },
): string {
  if (remainingMs === undefined || Number.isNaN(remainingMs)) {
    return "unknown";
  }
  if (remainingMs <= 0) {
    return "0m";
  }
  const minutes = Math.round(remainingMs / 60_000);
  if (minutes < 1) {
    return opts?.underMinuteLabel ?? "1m";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function resolveOAuthStatus(
  expiresAt: number | undefined,
  now: number,
  expiringWithinMs: number,
): { status: AuthProfileHealthStatus; expiresAt?: number; remainingMs?: number } {
  const normalizedExpiresAt = asDateTimestampMs(expiresAt);
  if (normalizedExpiresAt === undefined || normalizedExpiresAt <= 0) {
    return { status: "missing" };
  }
  const remainingMs = normalizedExpiresAt - now;
  const expiryState = resolveTokenExpiryState(normalizedExpiresAt, now, {
    expiringWithinMs,
  });
  if (expiryState === "invalid_expires" || expiryState === "missing") {
    return { status: "missing" };
  }
  return {
    status: expiryState === "valid" ? "ok" : expiryState,
    expiresAt: normalizedExpiresAt,
    remainingMs,
  };
}

function buildProfileHealth(params: {
  profileId: string;
  credential: AuthProfileCredential;
  runtimeCredential?: AuthProfileCredential;
  store: AuthProfileStore;
  cfg?: OpenClawConfig;
  now: number;
  warnAfterMs?: number;
}): AuthProfileHealth {
  const { profileId, credential, runtimeCredential, store, cfg, now, warnAfterMs } = params;
  const label = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
  const healthCredential = runtimeCredential ?? credential;
  const profile = {
    profileId,
    provider: normalizeProviderId(healthCredential.provider),
    type: healthCredential.type,
    source: "store" as const,
    label,
  };
  const expiringProfileHealth = (
    expires: number | undefined,
    expiringWithinMs: number,
    includeExpiredReason = false,
  ): AuthProfileHealth => {
    const { status, expiresAt, remainingMs } = resolveOAuthStatus(expires, now, expiringWithinMs);
    return {
      ...profile,
      status,
      ...(includeExpiredReason ? { reasonCode: status === "expired" ? "expired" : undefined } : {}),
      expiresAt,
      remainingMs,
    };
  };

  if (credential.setup?.replacement) {
    return {
      ...profile,
      type: credential.type,
      status: "missing",
      reasonCode: "setup_inactive",
      label: `${label} (saved, inactive)`,
    };
  }

  const storedEligibility = evaluateStoredCredentialEligibility({
    credential: healthCredential,
    now,
  });
  if (
    !storedEligibility.eligible &&
    (healthCredential.type !== "oauth" || storedEligibility.reasonCode === "unresolved_ref")
  ) {
    return {
      ...profile,
      status: storedEligibility.reasonCode === "expired" ? "expired" : "missing",
      reasonCode: storedEligibility.reasonCode,
    };
  }

  if (healthCredential.type === "api_key") {
    return {
      ...profile,
      status: "static",
    };
  }

  if (healthCredential.type === "token") {
    const expiryState = resolveTokenExpiryState(healthCredential.expires, now);
    const expiresAt = expiryState === "valid" ? healthCredential.expires : undefined;
    if (!expiresAt) {
      return {
        ...profile,
        status: "static",
      };
    }
    return expiringProfileHealth(expiresAt, warnAfterMs ?? DEFAULT_OAUTH_WARN_MS, true);
  }

  const effectiveCredential = resolveEffectiveOAuthCredential({
    profileId,
    credential: healthCredential,
  });
  const eligibility = evaluateStoredCredentialEligibility({
    credential: effectiveCredential,
    now,
  });
  if (!eligibility.eligible) {
    return {
      ...profile,
      status: eligibility.reasonCode === "expired" ? "expired" : "missing",
      reasonCode: eligibility.reasonCode,
    };
  }

  const oauthWarnAfterMs = Math.max(
    warnAfterMs ??
      (normalizeSecretInputString(effectiveCredential.refresh) ? 0 : DEFAULT_OAUTH_WARN_MS),
    DEFAULT_OAUTH_REFRESH_MARGIN_MS,
  );
  return expiringProfileHealth(effectiveCredential.expires, oauthWarnAfterMs);
}

/** Build profile and provider auth health rollups from an auth profile store. */
export function buildAuthHealthSummary(params: {
  store: AuthProfileStore;
  cfg?: OpenClawConfig;
  warnAfterMs?: number;
  providers?: string[];
  runtimeCredentialsByProvider?: ReadonlyMap<string, AuthProfileCredential>;
  /** Exact prepared metadata for request paths that must not rediscover plugin aliases. */
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
}): AuthHealthSummary {
  const now = Date.now();
  const warnAfterMs = params.warnAfterMs ?? DEFAULT_OAUTH_WARN_MS;
  const providerFilter = params.providers
    ? new Set(normalizeUniqueStringEntries(params.providers.map((p) => normalizeProviderId(p))))
    : null;

  const profiles = Object.entries(params.store.profiles)
    .filter(([, cred]) =>
      providerFilter ? providerFilter.has(normalizeProviderId(cred.provider)) : true,
    )
    .map(([profileId, credential]) =>
      buildProfileHealth({
        profileId,
        credential,
        runtimeCredential: params.runtimeCredentialsByProvider?.get(
          normalizeProviderId(credential.provider),
        ),
        store: params.store,
        cfg: params.cfg,
        now,
        warnAfterMs: params.warnAfterMs,
      }),
    )
    .toSorted((a, b) => {
      if (a.provider !== b.provider) {
        return a.provider.localeCompare(b.provider);
      }
      return a.profileId.localeCompare(b.profileId);
    });

  const providersMap = new Map<string, AuthProviderHealth>();
  const providerHealth = (provider: string) => {
    const health: AuthProviderHealth = providersMap.get(provider) ?? {
      provider,
      status: "missing",
      profiles: [],
    };
    providersMap.set(provider, health);
    return health;
  };
  for (const profile of profiles) {
    providerHealth(profile.provider).profiles.push(profile);
  }
  for (const provider of providerFilter ?? []) {
    providerHealth(provider);
  }

  const resolveProviderStatusProfiles = (provider: AuthProviderHealth): AuthProfileHealth[] => {
    const { order: explicitOrder } = resolveExplicitAuthOrderSelection({
      storeOrder: params.store.order,
      configuredOrder: params.cfg?.auth?.order,
      providerKey: provider.provider,
      providerAuthKey: resolveProviderIdForAuth(provider.provider, {
        config: params.cfg,
        ...params.authAliasLookupParams,
        storedCredential: true,
      }),
    });
    if (explicitOrder && explicitOrder.length === 0) {
      return [];
    }

    const ordered = resolveAuthProfileOrder({
      cfg: params.cfg,
      store: params.store,
      provider: provider.provider,
      authAliasLookupParams: params.authAliasLookupParams,
    });
    const profilesForOrder = (profileIds: readonly string[]) =>
      profileIds.flatMap(
        (profileId) => provider.profiles.find((profile) => profile.profileId === profileId) ?? [],
      );
    const orderedProfiles = profilesForOrder(ordered);

    if (orderedProfiles.length > 0) {
      return orderedProfiles;
    }

    return explicitOrder ? profilesForOrder(explicitOrder) : provider.profiles;
  };

  for (const provider of providersMap.values()) {
    const effectiveProfiles = resolveProviderStatusProfiles(provider);
    provider.effectiveProfiles = effectiveProfiles;
    if (effectiveProfiles.length === 0) {
      provider.status = "missing";
      provider.expiresAt = undefined;
      provider.remainingMs = undefined;
      continue;
    }

    const expirableProfiles = effectiveProfiles.filter((profile) => profile.type !== "api_key");
    const statuses = new Set(effectiveProfiles.map((profile) => profile.status));
    provider.status =
      (["expired", "missing", "expiring"] as const).find((status) => statuses.has(status)) ??
      (expirableProfiles.length > 0 ? "ok" : "static");

    let earliestExpiry: number | undefined;
    for (const profile of expirableProfiles) {
      if (profile.expiresAt !== undefined) {
        earliestExpiry =
          earliestExpiry === undefined
            ? profile.expiresAt
            : Math.min(earliestExpiry, profile.expiresAt);
      }
    }

    if (earliestExpiry !== undefined) {
      provider.expiresAt = earliestExpiry;
      provider.remainingMs = provider.expiresAt - now;
    }
  }

  const providers = Array.from(providersMap.values()).toSorted((a, b) =>
    a.provider.localeCompare(b.provider),
  );

  return { now, warnAfterMs, profiles, providers };
}
