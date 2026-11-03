import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "../api.js";
import type { VoiceCallConfig } from "./config.js";

// Resolves the model used for voice-call text response generation.

/** Resolve provider/model fields from explicit voice config or agent defaults. */
export function resolveVoiceResponseModel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  voiceConfig: VoiceCallConfig;
  agentRuntime: OpenClawPluginApi["runtime"]["agent"];
}): {
  modelRef: string;
  provider: string;
  model: string;
} {
  if (!params.voiceConfig.responseModel) {
    // An unset responseModel inherits the call agent's effective model like every
    // other agent turn; the compiled-in runtime default is only the last resort.
    const configured = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
    return {
      modelRef: `${configured.provider}/${configured.model}`,
      provider: configured.provider,
      model: configured.model,
    };
  }
  const modelRef = params.voiceConfig.responseModel;
  const slashIndex = modelRef.indexOf("/");

  return {
    modelRef,
    provider:
      slashIndex === -1 ? params.agentRuntime.defaults.provider : modelRef.slice(0, slashIndex),
    model: slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1),
  };
}
