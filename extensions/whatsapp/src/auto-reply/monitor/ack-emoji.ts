import { resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

const DEFAULT_WHATSAPP_ACK_REACTION = "👀";

export function resolveWhatsAppAckEmoji(params: {
  cfg: OpenClawConfig;
  agentId: string;
  ackConfig: string | { emoji?: string } | undefined;
}): string {
  if (!params.ackConfig) {
    return "";
  }
  const configured =
    typeof params.ackConfig === "string" ? params.ackConfig : params.ackConfig.emoji;
  return (
    configured?.trim() ||
    resolveAgentIdentity(params.cfg, params.agentId)?.emoji?.trim() ||
    DEFAULT_WHATSAPP_ACK_REACTION
  );
}
