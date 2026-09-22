/**
 * Model selection resolution facade.
 *
 * This module resolves configured fallbacks and explicit model selections.
 */
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentModelFallbacksOverride } from "./agent-scope.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import {
  type ModelManifestNormalizationContext,
  type ModelRef,
  normalizeProviderId,
} from "./model-ref-shared.js";
import {
  buildModelAliasIndex,
  getModelRefStatus,
  resolveAllowedModelRefFromAliasIndex,
  resolveModelRefFromString,
  type ModelAliasIndex,
} from "./model-selection-shared.js";

export {
  buildModelAliasIndex,
  getModelRefStatus,
  normalizeModelSelection,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
  resolveModelRefFromString,
} from "./model-selection-shared.js";

/** Resolves legacy provider/model pairs whose model field may still contain an alias. */
export function resolveModelAliasFromPair(
  params: {
    cfg?: OpenClawConfig;
    agentId?: string;
    provider: string;
    model: string;
    defaultProvider: string;
    aliasIndex?: ModelAliasIndex;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef | null {
  const bareAlias = resolveModelRefFromString({
    ...params,
    raw: params.model,
    defaultProvider: params.provider,
  });
  const providerAlias = resolveModelRefFromString({
    ...params,
    raw: `${params.provider}/${params.model}`,
  });
  if (providerAlias?.alias) {
    return providerAlias.ref;
  }
  const provider = normalizeProviderId(params.provider);
  return bareAlias?.alias &&
    (normalizeProviderId(bareAlias.ref.provider) === provider ||
      provider === normalizeProviderId(params.defaultProvider))
    ? bareAlias.ref
    : null;
}

/** Resolve agent-owned fallback overrides without loading the full selection facade. */
export function resolveConfiguredModelFallbacks(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): string[] {
  if (params.agentId) {
    const override = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
    if (override !== undefined) {
      return override;
    }
  }
  return resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
}

/** Resolves a raw model string into an allowed model ref or an explanatory error. */
export function resolveAllowedModelRefCore(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    raw: string;
    defaultProvider: string;
    defaultModel?: string | ModelRef;
    agentId?: string;
  } & ModelManifestNormalizationContext,
):
  | { ref: ModelRef; key: string }
  | {
      error: string;
    } {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    agentId: params.agentId,
    manifestPlugins: params.manifestPlugins,
  });
  return resolveAllowedModelRefFromAliasIndex({
    cfg: params.cfg,
    raw: params.raw,
    defaultProvider: params.defaultProvider,
    agentId: params.agentId,
    aliasIndex,
    manifestPlugins: params.manifestPlugins,
    getStatus: (ref) =>
      getModelRefStatus({
        cfg: params.cfg,
        catalog: params.catalog,
        ref,
        defaultProvider: params.defaultProvider,
        defaultModel: params.defaultModel,
        agentId: params.agentId,
        manifestPlugins: params.manifestPlugins,
      }),
  });
}
