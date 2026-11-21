import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveRealtimeVoiceAgentContextInstructions } from "openclaw/plugin-sdk/realtime-bootstrap-context";
import type { VoiceCallConfig } from "./config.js";

export async function buildRealtimeVoiceInstructions(params: {
  baseInstructions: string;
  config: VoiceCallConfig;
  coreConfig: OpenClawConfig;
  agentId: string;
  warn?: (message: string) => void;
}): Promise<string> {
  const { config } = params;
  const contextConfig = config.realtime.agentContext;
  // The consult-policy block depends on the routed model's capabilities; the
  // realtime handler appends it once the session policy is resolved.
  const sections = [params.baseInstructions];
  sections.push(
    await resolveRealtimeVoiceAgentContextInstructions({
      config: params.coreConfig,
      agentId: params.agentId,
      files:
        contextConfig.enabled && contextConfig.includeWorkspaceFiles ? contextConfig.files : [],
      includeIdentity: contextConfig.enabled && contextConfig.includeIdentity,
      maxChars: contextConfig.maxChars,
      warn: params.warn,
    }),
  );
  return sections.filter(Boolean).join("\n\n");
}
