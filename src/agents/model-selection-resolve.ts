import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig, resolveAgentModelFallbacksOverride } from "./agent-scope.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import type { ModelRef } from "./model-selection-normalize.js";
import {
  buildModelAliasIndex,
  getModelRefStatusWithFallbackModels,
  resolveAllowedModelRefFromAliasIndex,
  type ModelRefStatus,
} from "./model-selection-shared.js";

export {
  buildConfiguredAllowlistKeys,
  buildModelAliasIndex,
  normalizeModelSelection,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
  resolveModelRefFromString,
} from "./model-selection-shared.js";
export type { ModelRefStatus } from "./model-selection-shared.js";

function resolveFallbackModels(cfg: OpenClawConfig, agentId?: string): string[] {
  if (agentId) {
    const override = resolveAgentModelFallbacksOverride(cfg, agentId);
    if (override !== undefined) {
      return override;
    }
    const agentModels = resolveAgentConfig(cfg, agentId)?.models;
    if (agentModels && Object.keys(agentModels).length > 0) {
      return [];
    }
  }
  return resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
}

export function getModelRefStatus(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  ref: ModelRef;
  defaultProvider: string;
  defaultModel?: string;
  agentId?: string;
}): ModelRefStatus {
  const { cfg, catalog, ref, defaultProvider, defaultModel } = params;
  return getModelRefStatusWithFallbackModels({
    cfg,
    catalog,
    ref,
    defaultProvider,
    defaultModel,
    fallbackModels: resolveFallbackModels(cfg, params.agentId),
    agentId: params.agentId,
  });
}

export function resolveAllowedModelRef(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  raw: string;
  defaultProvider: string;
  defaultModel?: string;
  agentId?: string;
}):
  | { ref: ModelRef; key: string }
  | {
      error: string;
    } {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    agentId: params.agentId,
  });
  return resolveAllowedModelRefFromAliasIndex({
    cfg: params.cfg,
    raw: params.raw,
    defaultProvider: params.defaultProvider,
    agentId: params.agentId,
    aliasIndex,
    getStatus: (ref) =>
      getModelRefStatus({
        cfg: params.cfg,
        catalog: params.catalog,
        ref,
        defaultProvider: params.defaultProvider,
        defaultModel: params.defaultModel,
        agentId: params.agentId,
      }),
  });
}
