import type { ClawdbotConfig, IdentityConfig } from "../config/config.js";
import { resolveAgentConfig } from "./agent-scope.js";

const DEFAULT_ACK_REACTION = "👀";

export function resolveAgentIdentity(
  cfg: ClawdbotConfig,
  agentId: string,
): IdentityConfig | undefined {
  return resolveAgentConfig(cfg, agentId)?.identity;
}

export function resolveAckReaction(
  cfg: ClawdbotConfig,
  agentId: string,
): string {
  const configured = cfg.messages?.ackReaction;
  if (configured !== undefined) return configured.trim();
  const emoji = resolveAgentIdentity(cfg, agentId)?.emoji?.trim();
  return emoji || DEFAULT_ACK_REACTION;
}
