import type { VoiceCallConfig } from "./config.js";
import type { CoreAgentDeps } from "./core-bridge.js";

/**
 * Resolves the provider/model pair used for non-realtime voice responses.
 *
 * `responseModel` accepts either `provider/model-id` or a legacy single-segment
 * model id. Multi-segment provider model ids split only at the first slash.
 */
export function resolveVoiceResponseModel(params: {
  /** Voice-call config containing the optional response model override. */
  voiceConfig: VoiceCallConfig;
  /** Runtime defaults used when config omits a model or uses a legacy bare model id. */
  agentRuntime: CoreAgentDeps;
}): {
  /** Original model reference used for diagnostics and request metadata. */
  modelRef: string;
  /** Provider id selected from the prefix or runtime default. */
  provider: string;
  /** Provider-owned model id, which may itself contain slash-delimited path segments. */
  model: string;
} {
  const modelRef =
    params.voiceConfig.responseModel ??
    `${params.agentRuntime.defaults.provider}/${params.agentRuntime.defaults.model}`;
  // Split only on the first slash so model ids can contain provider-owned path segments.
  const slashIndex = modelRef.indexOf("/");

  return {
    modelRef,
    provider:
      slashIndex === -1 ? params.agentRuntime.defaults.provider : modelRef.slice(0, slashIndex),
    model: slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1),
  };
}
