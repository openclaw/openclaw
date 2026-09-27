import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveRealtimeVoiceAgentContextInstructions } from "openclaw/plugin-sdk/realtime-bootstrap-context";
import { buildRealtimeVoiceAgentConsultPolicyInstructions } from "openclaw/plugin-sdk/realtime-voice";
import type { VoiceCallConfig } from "./config.js";

/** Build final realtime instructions from base instructions, consult policy, and agent context. */
export async function buildRealtimeVoiceInstructions(params: {
  baseInstructions: string;
  config: VoiceCallConfig;
  coreConfig: OpenClawConfig;
  agentId: string;
  warn?: (message: string) => void;
}): Promise<string> {
  const { config } = params;
  const contextConfig = config.realtime.agentContext;
  return [
    params.baseInstructions,
    buildRealtimeVoiceAgentConsultPolicyInstructions(config.realtime),
    await resolveRealtimeVoiceAgentContextInstructions({
      config: params.coreConfig,
      agentId: params.agentId,
      files:
        contextConfig.enabled && contextConfig.includeWorkspaceFiles ? contextConfig.files : [],
      includeIdentity: contextConfig.enabled && contextConfig.includeIdentity,
      maxChars: contextConfig.maxChars,
      warn: params.warn,
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
}
