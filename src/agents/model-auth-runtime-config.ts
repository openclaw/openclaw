/**
 * Runtime-config-backed provider auth that does not require plugin activation.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { getConfigProviderUseBindings } from "../config/resolution-facts.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveProviderBindingEnvVarCandidates } from "../secrets/provider-env-vars.js";
import {
  findActiveDegradedSecretOwner,
  SecretSurfaceUnavailableError,
} from "../secrets/runtime-degraded-state.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import {
  captureRuntimeAuthSharedOwner,
  runtimeAuthProfileSnapshotSharesOwner,
} from "./auth-profiles/runtime-snapshot-owner.js";
import { listOwnedRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import * as authConfig from "./model-auth-provider-config.js";
import { ProviderAuthError, type ResolvedProviderAuth } from "./model-auth-runtime-shared.js";
import { resolveProviderAuthAliasMap } from "./provider-auth-aliases.js";
import { findStartupProviderUseBindingConflict } from "./provider-model-auth-source-plan.js";

/** Reads a runtime-resolved credential for a SecretRef-backed provider entry. */
export function resolveManagedSecretRefRuntimeProviderAuth(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  secretSentinels?: boolean;
}): ResolvedProviderAuth | undefined {
  const runtimeConfig = getRuntimeConfigSnapshot();
  const runtimeSourceConfig = getRuntimeConfigSourceSnapshot();
  if (params.cfg && params.cfg !== runtimeConfig && !runtimeSourceConfig) {
    return undefined;
  }
  const applicableConfig = selectApplicableRuntimeConfig({
    inputConfig: params.cfg,
    runtimeConfig,
    runtimeSourceConfig,
  });
  const usesRuntimeProvider =
    applicableConfig === runtimeConfig ||
    authConfig.providerConfigMatchesRuntimeSnapshot({
      inputConfig: params.cfg,
      runtimeConfig,
      provider: params.provider,
    });
  const sourceConfig = usesRuntimeProvider ? (runtimeSourceConfig ?? undefined) : params.cfg;
  if (!authConfig.hasSecretRefProviderApiKey(sourceConfig, params.provider)) {
    return undefined;
  }
  if (!runtimeConfig || !usesRuntimeProvider) {
    return undefined;
  }
  const resolved = authConfig.resolveRuntimeProviderConfigApiKeyAuth({
    cfg: runtimeConfig,
    sourceConfig,
    provider: params.provider,
  });
  if (!resolved?.apiKey) {
    return undefined;
  }
  return {
    ...resolved,
    apiKey: params.secretSentinels
      ? mintSecretSentinel(resolved.apiKey, {
          label: `model-auth:${params.provider}`,
        })
      : resolved.apiKey,
  };
}

export function assertRuntimeProviderSecretOwnerAvailable(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
}): void {
  const provider = normalizeProviderId(params.provider);
  const degraded = findActiveDegradedSecretOwner("provider", provider);
  if (!degraded) {
    return;
  }
  const runtimeConfig = getRuntimeConfigSnapshot();
  const runtimeSourceConfig = getRuntimeConfigSourceSnapshot();
  const usesRuntimeProvider =
    !params.cfg ||
    params.cfg === runtimeConfig ||
    params.cfg === runtimeSourceConfig ||
    authConfig.providerConfigMatchesRuntimeSnapshot({
      inputConfig: params.cfg,
      runtimeConfig,
      provider,
    });
  if (usesRuntimeProvider) {
    throw new SecretSurfaceUnavailableError(degraded);
  }
}

/** Rechecks published account scopes without reopening the filesystem on request paths. */
export function resolveStartupProviderUseBindingConflict(params: {
  provider: string;
  cfg?: OpenClawConfig;
  store?: AuthProfileStore;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
}): ProviderAuthError | undefined {
  const config = authConfig.resolveProviderSourceConfig(params.cfg, params.provider);
  if (!getConfigProviderUseBindings(config)[normalizeProviderId(params.provider)]) {
    return undefined;
  }
  const env = params.env ?? process.env;
  const owner = captureRuntimeAuthSharedOwner(env);
  const persistedEntries = (store: AuthProfileStore | undefined) => {
    const persistedIds = new Set(store?.runtimePersistedProfileIds ?? []);
    return Object.entries(store?.profiles ?? {}).filter(([profileId]) =>
      persistedIds.has(profileId),
    );
  };
  const profiles = [
    ...persistedEntries(params.store),
    ...listOwnedRuntimeAuthProfileStoreSnapshots()
      .filter((entry) => runtimeAuthProfileSnapshotSharesOwner(entry.owner, owner))
      .flatMap((entry) => persistedEntries(entry.store)),
  ];
  const lookup = {
    config,
    env,
    workspaceDir: params.workspaceDir,
    metadataSnapshot: params.metadataSnapshot,
  };
  const profileId = findStartupProviderUseBindingConflict({
    provider: params.provider,
    config,
    profiles,
    providerEnvVars: resolveProviderBindingEnvVarCandidates(lookup),
    providerAuthAliases: resolveProviderAuthAliasMap(lookup),
  });
  if (profileId) {
    return new ProviderAuthError(
      "missing-provider-auth",
      params.provider,
      `Startup provider binding for "${params.provider}" conflicts with saved profile "${profileId}". Bind the provider explicitly to the intended account before retrying.`,
    );
  }
  return undefined;
}

export function assertStartupProviderUseBindingCurrent(
  params: Parameters<typeof resolveStartupProviderUseBindingConflict>[0],
): void {
  const error = resolveStartupProviderUseBindingConflict(params);
  if (error) {
    throw error;
  }
}
