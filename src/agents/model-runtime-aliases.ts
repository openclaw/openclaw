/**
 * Resolves CLI runtime aliases to provider/model auth labels and execution ids.
 */
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isCliRuntimeModelBackendForProvider,
  listCliRuntimeModelBackendBindings,
  listCliRuntimeProviderIds,
  resolveCliRuntimeCanonicalProvider,
  resolveCliRuntimeModelBackendBinding,
} from "./cli-backends.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

/** True for CLI runtime provider ids such as `claude-cli` and `google-gemini-cli`. */
export function isCliRuntimeProvider(
  provider: string,
  params: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv; includeSetupRegistry?: boolean } = {},
): boolean {
  const normalized = normalizeProviderId(provider);
  return listCliRuntimeProviderIds({
    config: params.config,
    env: params.env,
    includeSetupRegistry:
      params.includeSetupRegistry ?? (params.config !== undefined || params.env !== undefined),
  }).includes(normalized);
}

export function isCliRuntimeAlias(runtime: string | undefined): boolean {
  const normalized = normalizeProviderId(runtime ?? "");
  return normalized
    ? listCliRuntimeModelBackendBindings().some((binding) => binding.runtime === normalized)
    : false;
}

export function isCliRuntimeAliasForProvider(params: {
  runtime: string | undefined;
  provider: string | undefined;
  cfg?: OpenClawConfig;
}): boolean {
  return isCliRuntimeModelBackendForProvider({
    provider: params.provider,
    runtime: params.runtime,
    config: params.cfg,
  });
}

type RuntimeAliasComparisonOptions = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  includeSetupRegistry?: boolean;
};

function canonicalizeRuntimeAliasProvider(
  provider: string,
  options: RuntimeAliasComparisonOptions = {},
): string {
  return (
    resolveCliRuntimeCanonicalProvider({
      runtime: provider,
      config: options.config,
      env: options.env,
      includeSetupRegistry:
        options.includeSetupRegistry ?? (options.config !== undefined || options.env !== undefined),
    }) ?? provider
  );
}

function normalizeRuntimeModelRefForComparison(
  raw: string,
  options: RuntimeAliasComparisonOptions = {},
): string {
  const trimmed = raw.trim();
  const parsed = parseModelCatalogRef(trimmed);
  if (!parsed) {
    return normalizeProviderId(canonicalizeRuntimeAliasProvider(trimmed, options));
  }
  const canonicalProvider = normalizeProviderId(
    canonicalizeRuntimeAliasProvider(parsed.provider, options),
  );
  return `${canonicalProvider}/${parsed.modelId}`;
}

function normalizeRuntimeModelRefWithoutAlias(raw: string): string {
  const trimmed = raw.trim();
  const parsed = parseModelCatalogRef(trimmed);
  if (!parsed) {
    return normalizeProviderId(trimmed);
  }
  return `${parsed.provider}/${parsed.modelId}`;
}

export function areRuntimeModelRefsEquivalent(
  left: string,
  right: string,
  options: RuntimeAliasComparisonOptions = {},
): boolean {
  if (normalizeRuntimeModelRefWithoutAlias(left) === normalizeRuntimeModelRefWithoutAlias(right)) {
    return true;
  }
  return (
    normalizeRuntimeModelRefForComparison(left, options) ===
    normalizeRuntimeModelRefForComparison(right, options)
  );
}

export function shouldPreferActiveRuntimeAliasAuthLabel(params: {
  runtimeAliasModelEquivalent: boolean;
  selectedAuthLabel?: string;
  activeAuthLabel?: string;
}): boolean {
  if (!params.runtimeAliasModelEquivalent) {
    return false;
  }
  const selectedAuth = normalizeOptionalLowercaseString(params.selectedAuthLabel);
  const activeAuth = normalizeOptionalLowercaseString(params.activeAuthLabel);
  if (!activeAuth || activeAuth === "unknown") {
    return false;
  }
  return (
    selectedAuth === "unknown" ||
    (Boolean(selectedAuth?.startsWith("api-key")) &&
      (activeAuth.startsWith("oauth") || activeAuth.startsWith("token")))
  );
}

function resolveConfiguredRuntime(params: {
  cfg?: OpenClawConfig;
  provider: string;
  agentId?: string;
  modelId?: string;
}): { runtime?: string; matchedProvider?: string } {
  const policy = resolveModelRuntimePolicy({
    config: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
  });
  return {
    runtime: policy.policy?.id?.trim() || undefined,
    matchedProvider: policy.matchedProvider,
  };
}

function resolveProfileRuntimeAlias(params: {
  cfg?: OpenClawConfig;
  provider: string;
  profileId: string;
}): string | undefined {
  const profile = params.cfg?.auth?.profiles?.[params.profileId];
  if (!profile?.provider) {
    return undefined;
  }
  const provider = normalizeProviderId(params.provider);
  const profileProvider = normalizeProviderId(profile.provider);
  if (!provider || !profileProvider || profileProvider === provider) {
    return undefined;
  }

  // CLI runtime auth profiles are intentionally stored under their runtime provider
  // id (for example google-gemini-cli). Treat a setup/runtime backend binding as
  // sufficient compatibility even when the canonical provider no longer registers
  // that runtime provider by default.
  const runtimeAlias = resolveCliRuntimeModelBackendBinding({
    config: params.cfg,
    provider,
    runtime: profileProvider,
  })?.runtime;
  if (runtimeAlias) {
    return runtimeAlias;
  }

  const providerAuthKey = resolveProviderIdForAuth(provider, { config: params.cfg });
  const profileAuthKey = resolveProviderIdForAuth(profileProvider, { config: params.cfg });
  if (providerAuthKey !== profileAuthKey) {
    return undefined;
  }
  return resolveCliRuntimeModelBackendBinding({
    config: params.cfg,
    provider,
    runtime: profileProvider,
  })?.runtime;
}

function isDirectAuthProfileForProvider(params: {
  cfg?: OpenClawConfig;
  providerAuthKey: string;
  profileId: string;
}): boolean {
  const profileProvider = params.cfg?.auth?.profiles?.[params.profileId]?.provider;
  if (!profileProvider) {
    return false;
  }
  return resolveProviderIdForAuth(profileProvider, { config: params.cfg }) === params.providerAuthKey;
}

function listRuntimeOrderKeysForProvider(params: {
  cfg?: OpenClawConfig;
  provider: string;
}): string[] {
  const provider = normalizeProviderId(params.provider);
  const order = params.cfg?.auth?.order;
  if (!provider || !order) {
    return [];
  }
  return Object.keys(order)
    .map((runtime) => normalizeProviderId(runtime))
    .filter(
      (runtime) =>
        runtime !== provider &&
        resolveCliRuntimeModelBackendBinding({
          config: params.cfg,
          provider,
          runtime,
        })?.runtime === runtime,
    );
}

function resolveCliRuntimeFromAuthProfile(params: {
  cfg?: OpenClawConfig;
  provider: string;
  authProfileId?: string;
}): string | undefined {
  if (!params.cfg?.auth?.profiles) {
    return undefined;
  }
  if (params.authProfileId?.trim()) {
    return resolveProfileRuntimeAlias({
      cfg: params.cfg,
      provider: params.provider,
      profileId: params.authProfileId.trim(),
    });
  }

  const provider = normalizeProviderId(params.provider);
  const providerAuthKey = resolveProviderIdForAuth(provider, { config: params.cfg });
  const orderedProfileIds = [
    ...(params.cfg.auth.order?.[providerAuthKey] ?? []),
    ...(providerAuthKey === provider ? [] : (params.cfg.auth.order?.[provider] ?? [])),
    ...listRuntimeOrderKeysForProvider({ cfg: params.cfg, provider }).flatMap(
      (runtime) => params.cfg?.auth?.order?.[runtime] ?? [],
    ),
  ];
  for (const profileId of orderedProfileIds) {
    const runtimeAlias = resolveProfileRuntimeAlias({ cfg: params.cfg, provider, profileId });
    if (runtimeAlias) {
      return runtimeAlias;
    }
    if (isDirectAuthProfileForProvider({ cfg: params.cfg, providerAuthKey, profileId })) {
      return undefined;
    }
  }

  const directProfileIds = Object.entries(params.cfg.auth.profiles)
    .filter(([, profile]) => normalizeProviderId(profile?.provider ?? "") === provider)
    .map(([profileId]) => profileId);
  if (directProfileIds.length > 0) {
    return undefined;
  }

  const compatibleRuntimeProfileIds = Object.entries(params.cfg.auth.profiles)
    .filter(([profileId, profile]) => {
      if (!profile?.provider) {
        return false;
      }
      return resolveProfileRuntimeAlias({ cfg: params.cfg, provider, profileId }) !== undefined;
    })
    .map(([profileId]) => profileId);
  if (compatibleRuntimeProfileIds.length !== 1) {
    return undefined;
  }
  const [profileId] = compatibleRuntimeProfileIds;
  return profileId
    ? resolveProfileRuntimeAlias({ cfg: params.cfg, provider, profileId })
    : undefined;
}

export function resolveCliRuntimeExecutionProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentId?: string;
  modelId?: string;
  authProfileId?: string;
}): string | undefined {
  const provider = normalizeProviderId(params.provider);
  const { runtime, matchedProvider } = resolveConfiguredRuntime({ ...params, provider });
  if (runtime === "openclaw") {
    return undefined;
  }
  if (!runtime || runtime === "auto") {
    return resolveCliRuntimeFromAuthProfile({ ...params, provider });
  }
  const effectiveProvider = provider || normalizeProviderId(matchedProvider ?? "");
  if (!effectiveProvider) {
    return undefined;
  }
  return resolveCliRuntimeModelBackendBinding({
    config: params.cfg,
    provider: effectiveProvider,
    runtime,
  })?.runtime;
}
