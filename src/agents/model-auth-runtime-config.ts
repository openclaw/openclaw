/**
 * Runtime-config-backed provider auth that does not require plugin activation.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  findActiveDegradedSecretOwner,
  SecretSurfaceUnavailableError,
} from "../secrets/runtime-degraded-state.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import * as authConfig from "./model-auth-provider-config.js";
import type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";

/** Reads a runtime-resolved credential for a SecretRef-backed provider entry. */
export function resolveManagedSecretRefRuntimeProviderAuth(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  secretSentinels?: boolean;
}): ResolvedProviderAuth | undefined {
  const runtimeConfig = getRuntimeConfigSnapshot();
  const runtimeSourceConfig = getRuntimeConfigSourceSnapshot();
  const sourceConfig = runtimeSourceConfig ?? undefined;
  if (!runtimeConfig || !authConfig.hasSecretRefProviderApiKey(sourceConfig, params.provider)) {
    return undefined;
  }
  // Captured runtime providers usually match even though their full config differs from source.
  // Check that narrow boundary before comparing the entire fleet config.
  const usesRuntimeProvider =
    authConfig.providerConfigMatchesRuntimeSnapshot({
      inputConfig: params.cfg,
      runtimeConfig,
      provider: params.provider,
    }) ||
    selectApplicableRuntimeConfig({
      inputConfig: params.cfg,
      runtimeConfig,
      runtimeSourceConfig,
    }) === runtimeConfig;
  if (!usesRuntimeProvider) {
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
