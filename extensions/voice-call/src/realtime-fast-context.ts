import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveRealtimeVoiceFastContextConsult,
  type RealtimeVoiceFastContextConsultResult,
  type RealtimeVoiceFastContextConfig,
} from "openclaw/plugin-sdk/realtime-voice";

type Logger = {
  debug?: (message: string) => void;
};

/**
 * Resolves a realtime voice fast-context consult using voice-call-specific labels.
 *
 * This keeps the policy implementation in the shared SDK while making fallback
 * prompts and debug logs describe a phone caller instead of a generic user.
 */
export async function resolveRealtimeFastContextConsult(params: {
  /** Current OpenClaw config snapshot used by the shared resolver. */
  cfg: OpenClawConfig;
  /** Agent whose memory/session context should be queried. */
  agentId: string;
  /** Voice-call session key used to scope session context lookup. */
  sessionKey: string;
  /** Fast-context policy and retrieval limits from voice-call config. */
  config: RealtimeVoiceFastContextConfig;
  /** Tool-call arguments from the realtime model; validated by the SDK resolver. */
  args: unknown;
  /** Optional debug logger for SDK consult decisions. */
  logger: Logger;
}): Promise<RealtimeVoiceFastContextConsultResult> {
  // Voice-call consults share the SDK resolver, but label the audience as a
  // caller so fallback prompts and logs stay telephony-specific.
  return await resolveRealtimeVoiceFastContextConsult({
    ...params,
    labels: {
      audienceLabel: "caller",
      contextName: "OpenClaw memory or session context",
    },
  });
}
