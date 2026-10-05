import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as realtimeBootstrapSdk from "openclaw/plugin-sdk/realtime-bootstrap-context";
import { buildRealtimeVoiceAgentConsultPolicyInstructions } from "openclaw/plugin-sdk/realtime-voice";
import type { VoiceCallConfig } from "./config.js";
import { REALTIME_VOICE_CONSENT_QUESTION } from "./realtime-consent.js";

const contextSdk: Partial<
  Pick<typeof realtimeBootstrapSdk, "resolveRealtimeVoiceAgentContextInstructions">
> = realtimeBootstrapSdk;

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
  const sections = [
    params.baseInstructions,
    buildRealtimeVoiceAgentConsultPolicyInstructions(config.realtime),
  ];
  if (config.realtime.consentWindow.enabled) {
    sections.push(
      `Opening consent flow: Your first spoken response must ask exactly, "${REALTIME_VOICE_CONSENT_QUESTION}" Wait for the caller's answer before continuing the conversation.`,
    );
  }
  if (contextSdk.resolveRealtimeVoiceAgentContextInstructions) {
    sections.push(
      await contextSdk.resolveRealtimeVoiceAgentContextInstructions({
        config: params.coreConfig,
        agentId: params.agentId,
        files:
          contextConfig.enabled && contextConfig.includeWorkspaceFiles ? contextConfig.files : [],
        includeIdentity: contextConfig.enabled && contextConfig.includeIdentity,
        maxChars: contextConfig.maxChars,
        warn: params.warn,
      }),
    );
  } else {
    const { buildLegacyRealtimeVoiceAgentContext } =
      await import("./realtime-agent-context.legacy.js");
    sections.push(
      await buildLegacyRealtimeVoiceAgentContext({
        config: contextConfig,
        coreConfig: params.coreConfig,
        agentId: params.agentId,
      }),
    );
  }
  return sections.filter(Boolean).join("\n\n");
}
