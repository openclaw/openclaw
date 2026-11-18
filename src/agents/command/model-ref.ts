import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { allowsPluginModelNormalization } from "../configured-provider-model.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import {
  buildModelAliasIndex,
  normalizeModelRef,
  resolveModelRefFromString,
} from "../model-selection.js";
import { normalizeProviderModelIdWithRuntime } from "../provider-model-normalization.runtime.js";

const OVERRIDE_VALUE_MAX_LENGTH = 256;

export function normalizeExplicitOverrideInput(raw: string, kind: "provider" | "model"): string {
  const trimmed = raw.trim();
  const label = kind === "provider" ? "Provider" : "Model";
  if (!trimmed) {
    throw new Error(`${label} override must be non-empty.`);
  }
  if (trimmed.length > OVERRIDE_VALUE_MAX_LENGTH) {
    throw new Error(`${label} override exceeds ${String(OVERRIDE_VALUE_MAX_LENGTH)} characters.`);
  }
  if (/\p{Cc}/u.test(trimmed)) {
    throw new Error(`${label} override contains invalid control characters.`);
  }
  return trimmed;
}

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
