// Voice Call plugin module implements response model behavior.
import { buildModelAliasIndex, resolveModelRefFromString } from "openclaw/plugin-sdk/agent-runtime";
import type { VoiceCallConfig } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";

// Resolves the model used for voice-call text response generation.

/** Resolve provider/model fields from explicit voice config or agent defaults. */
export function resolveVoiceResponseModel(params: {
  voiceConfig: VoiceCallConfig;
  agentRuntime: CoreAgentDeps;
  coreConfig?: CoreConfig;
  agentId?: string;
}): {
  modelRef: string;
  provider: string;
  model: string;
} {
  if (params.coreConfig && params.voiceConfig.responseModel) {
    const aliasIndex = buildModelAliasIndex({
      cfg: params.coreConfig,
      defaultProvider: params.agentRuntime.defaults.provider,
      agentId: params.agentId,
    });
    const resolved = resolveModelRefFromString({
      cfg: params.coreConfig,
      raw: params.voiceConfig.responseModel,
      defaultProvider: params.agentRuntime.defaults.provider,
      aliasIndex,
    });
    if (resolved?.ref) {
      return {
        modelRef: `${resolved.ref.provider}/${resolved.ref.model}`,
        provider: resolved.ref.provider,
        model: resolved.ref.model,
      };
    }
  }

  const modelRef =
    params.voiceConfig.responseModel ??
    `${params.agentRuntime.defaults.provider}/${params.agentRuntime.defaults.model}`;
  const slashIndex = modelRef.indexOf("/");

  return {
    modelRef,
    provider:
      slashIndex === -1 ? params.agentRuntime.defaults.provider : modelRef.slice(0, slashIndex),
    model: slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1),
  };
}
