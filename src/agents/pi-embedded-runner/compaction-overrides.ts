import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import { splitModelRef } from "../model-ref.js";

export type ResolvedCompactionModelOverride = {
  provider: string;
  modelId: string;
  authProfileId?: string;
  originalProvider: string;
  originalModelId: string;
  overrideRaw?: string;
  overrideApplied: boolean;
  overrideInvalid: boolean;
};

export function resolveCompactionModelOverride(params: {
  provider: string;
  modelId: string;
  authProfileId?: string;
  cfg?: OpenClawConfig;
}): ResolvedCompactionModelOverride {
  const originalProvider = params.provider;
  const originalModelId = params.modelId;
  let provider = originalProvider;
  let modelId = originalModelId;
  let authProfileId = params.authProfileId;

  const overrideRaw = params.cfg?.agents?.defaults?.compaction?.model;
  const overrideTrimmed = typeof overrideRaw === "string" ? overrideRaw.trim() : undefined;

  let overrideApplied = false;
  let overrideInvalid = false;

  if (overrideTrimmed) {
    const { provider: overrideProvider, model: overrideModel } = splitModelRef(overrideTrimmed);
    if (overrideProvider && overrideModel && overrideProvider.trim() && overrideModel.trim()) {
      provider = overrideProvider.trim();
      modelId = overrideModel.trim();
      overrideApplied = provider !== originalProvider || modelId !== originalModelId;
      // Avoid applying an auth-profile id chosen for a different provider.
      if (provider !== originalProvider) {
        authProfileId = undefined;
      }
    } else {
      overrideInvalid = true;
    }
  }

  return {
    provider,
    modelId,
    authProfileId,
    originalProvider,
    originalModelId,
    overrideRaw: overrideTrimmed,
    overrideApplied,
    overrideInvalid,
  };
}

export function resolveCompactionThinkLevel(params: {
  thinkLevel?: ThinkLevel;
  cfg?: OpenClawConfig;
  modelOverrideApplied: boolean;
}): ThinkLevel | undefined {
  const configured = params.cfg?.agents?.defaults?.compaction?.thinking;
  if (configured) {
    return configured;
  }
  if (params.modelOverrideApplied) {
    return "off";
  }
  return params.thinkLevel;
}
