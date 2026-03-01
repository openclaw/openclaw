/**
 * Agent access control for group chats.
 *
 * Prevents unauthorized agents from responding in group chats by checking:
 * 1. Agent-level restrictions (allowedChatTypes)
 * 2. Channel-level restrictions (groupChat.allowedAgents)
 *
 * @see https://github.com/openclaw/openclaw/issues/25963
 */

import type { ChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { GroupChatConfig } from "../config/types.messages.js";

export type AgentRestrictionsConfig = {
  /** Chat types this agent is allowed to participate in. Omit or empty = all types allowed. */
  allowedChatTypes?: ChatType[];
};

export type AgentAccessCheckResult = {
  /** Whether the agent is allowed to respond in this context. */
  allowed: boolean;
  /** Reason for denial, if not allowed. */
  reason?: "agent_restricted" | "group_not_allowed" | "agent_not_in_allowlist";
  /** Human-readable description for logging. */
  description?: string;
};

/**
 * Check if an agent is allowed to respond in a given chat context.
 *
 * Checks are performed in order:
 * 1. Agent-level allowedChatTypes restriction
 * 2. Group-level allowedAgents restriction (for group chats)
 *
 * @param params - Check parameters
 * @returns Access check result with allowed status and optional denial reason
 */
export function checkAgentAllowedForChat(params: {
  /** Agent ID being checked. */
  agentId: string;
  /** Chat type: direct, group, or channel. */
  chatType: ChatType;
  /** Full OpenClaw config for looking up agent and group settings. */
  cfg: OpenClawConfig;
  /** Optional group config for allowedAgents check. */
  groupConfig?: GroupChatConfig;
}): AgentAccessCheckResult {
  const { agentId, chatType, cfg, groupConfig } = params;

  // Find the agent config
  const agentConfig = cfg.agents?.list?.find((a) => a.id === agentId);

  // Check 1: Agent-level allowedChatTypes restriction
  const agentRestrictions = agentConfig?.restrictions as AgentRestrictionsConfig | undefined;
  if (agentRestrictions?.allowedChatTypes?.length) {
    const allowedTypes = agentRestrictions.allowedChatTypes;
    if (!allowedTypes.includes(chatType)) {
      return {
        allowed: false,
        reason: "agent_restricted",
        description: `Agent '${agentId}' is restricted to chat types: ${allowedTypes.join(", ")}, but context is '${chatType}'`,
      };
    }
  }

  // Check 2: For group chats, check allowedAgents at the group config level
  if (chatType === "group") {
    // Check channel-level groupChat.allowedAgents
    const groupAllowedAgents = cfg.messages?.groupChat?.allowedAgents;
    if (groupAllowedAgents?.length) {
      if (!groupAllowedAgents.includes(agentId)) {
        return {
          allowed: false,
          reason: "agent_not_in_allowlist",
          description: `Agent '${agentId}' is not in the global groupChat.allowedAgents list`,
        };
      }
    }

    // Check per-group allowedAgents
    if (groupConfig?.allowedAgents?.length) {
      if (!groupConfig.allowedAgents.includes(agentId)) {
        return {
          allowed: false,
          reason: "group_not_allowed",
          description: `Agent '${agentId}' is not in this group's allowedAgents list`,
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Extend AgentConfig with restrictions field.
 * This is a type helper for use in config validation.
 */
export function hasAgentRestrictions(
  agent: AgentConfig,
): agent is AgentConfig & { restrictions: AgentRestrictionsConfig } {
  return agent.restrictions !== undefined;
}
