import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "../api.js";
import type { VoiceCallConfig } from "./config.js";

export function resolveVoiceResponseModel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  voiceConfig: VoiceCallConfig;
  agentRuntime: OpenClawPluginApi["runtime"]["agent"];
}): {
  provider: string;
  model: string;
} {
  const modelRef = params.voiceConfig.responseModel;
  if (!modelRef) {
    // An unset responseModel inherits the call agent's model like every other agent turn.
    const configured = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
    if (!configured) {
      throw new Error(
        "No model configured for voice responses. Choose a model in Settings → Models or set the voice-call responseModel.",
      );
    }
    return { provider: configured.provider, model: configured.model };
  }
  const slashIndex = modelRef.indexOf("/");

  return {
    // A legacy bare model id keeps the core bare-id provider.
    provider:
      slashIndex === -1 ? params.agentRuntime.defaults.provider : modelRef.slice(0, slashIndex),
    model: slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1),
  };
}
