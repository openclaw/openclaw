import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { allowsPluginModelNormalization } from "../configured-provider-model.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import {
  buildModelAliasIndex,
  normalizeModelRef,
  resolveModelRefFromString,
} from "../model-selection.js";
import { normalizeProviderModelIdWithRuntime } from "../provider-model-normalization.runtime.js";

export function normalizeAgentCommandModelRef(
  cfg: OpenClawConfig,
  provider: string,
  model: string,
  modelManifestContext: ModelManifestNormalizationContext,
) {
  return normalizeModelRef(provider, model, {
    ...modelManifestContext,
    allowPluginNormalization: allowsPluginModelNormalization({ cfg, provider, model }),
  });
}

export function parseAgentCommandModelRef(
  cfg: OpenClawConfig,
  agentId: string,
  raw: string,
  defaultProvider: string,
  modelManifestContext: ModelManifestNormalizationContext,
) {
  const parsed = resolveModelRefFromString({
    cfg,
    agentId,
    raw,
    defaultProvider,
    aliasIndex: buildModelAliasIndex({
      cfg,
      agentId,
      defaultProvider,
      ...modelManifestContext,
      allowPluginNormalization: false,
    }),
    ...modelManifestContext,
    allowPluginNormalization: false,
  })?.ref;
  if (!parsed || !allowsPluginModelNormalization({ cfg, ...parsed })) {
    return parsed ?? null;
  }
  // Parsing already applied manifest aliases; the runtime hook only refines that identity.
  return {
    provider: parsed.provider,
    model:
      normalizeProviderModelIdWithRuntime({
        provider: parsed.provider,
        context: { provider: parsed.provider, modelId: parsed.model },
      }) ?? parsed.model,
  };
}
