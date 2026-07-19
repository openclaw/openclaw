// Discord plugin module implements agent control behavior.
import {
  controlRealtimeVoiceAgentRun,
  shouldAutoControlRealtimeVoiceAgentText,
  type RealtimeVoiceAgentControlResult,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  resolveDiscordVoiceIngressAuthorityFacts,
  type DiscordVoiceIngressContext,
} from "./ingress.js";
import type { VoiceSessionEntry } from "./session.js";

type DiscordVoiceAgentControlOutcome =
  | {
      handled: true;
      result: RealtimeVoiceAgentControlResult;
      speakText?: string;
    }
  | {
      handled: false;
      result?: RealtimeVoiceAgentControlResult;
    };

export async function maybeControlDiscordVoiceAgentRun(params: {
  entry: Pick<VoiceSessionEntry, "accountId" | "channelId" | "route">;
  context?: DiscordVoiceIngressContext;
  userId?: string;
  text: string;
}): Promise<DiscordVoiceAgentControlOutcome> {
  if (!shouldAutoControlRealtimeVoiceAgentText(params.text)) {
    return { handled: false };
  }
  const ingressAuthority =
    params.context && params.userId
      ? resolveDiscordVoiceIngressAuthorityFacts({
          context: params.context,
          entry: params.entry,
          userId: params.userId,
        })
      : undefined;
  const result = await controlRealtimeVoiceAgentRun({
    sessionKey: params.entry.route.sessionKey,
    text: params.text,
    ...(ingressAuthority
      ? {
          ingressAuthority,
          agentId: params.entry.route.agentId,
          senderIsOwner: params.context?.senderIsOwner,
        }
      : {}),
  });

  if (!result.active) {
    return { handled: false, result };
  }

  return {
    handled: true,
    result,
    ...(result.speak && !result.suppress ? { speakText: result.message } : {}),
  };
}
