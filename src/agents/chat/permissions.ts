/**
 * Permission system for multi-agent chat channels.
 * Provides fine-grained access control for channel operations.
 */

import type { AgentChannel, AgentChannelMemberRole, ChannelPermission } from "./types/channels.js";
import { ROLE_PERMISSIONS, hasChannelPermission } from "./types/channels.js";

export type PermissionCheckResult = {
  allowed: boolean;
  reason?: string;
  requiredPermission?: ChannelPermission;
  actualRole?: AgentChannelMemberRole;
};

/**
 * Check if an agent has a specific permission in a channel.
 */
export function checkPermission(
  channel: AgentChannel,
  agentId: string,
  permission: ChannelPermission,
): PermissionCheckResult {
  const member = channel.members.find((m) => m.agentId === agentId);

  if (!member) {
    return {
      allowed: false,
      reason: "Agent is not a member of this channel",
      requiredPermission: permission,
    };
  }

  const allowed = hasChannelPermission(member.role, permission);

  if (!allowed) {
    return {
      allowed: false,
      reason: `Role '${member.role}' does not have '${permission}' permission`,
      requiredPermission: permission,
      actualRole: member.role,
    };
  }

  return {
    allowed: true,
    actualRole: member.role,
  };
}

/**
 * Check if an agent can perform an action on another agent.
 */
export function checkAgentAction(
  channel: AgentChannel,
  executorId: string,
  targetId: string,
  action: "kick" | "mute" | "role_change" | "mode_change",
): PermissionCheckResult {
  const executor = channel.members.find((m) => m.agentId === executorId);
  const target = channel.members.find((m) => m.agentId === targetId);

  if (!executor) {
    return {
      allowed: false,
      reason: "Executor is not a member of this channel",
    };
  }

  if (!target) {
    return {
      allowed: false,
      reason: "Target is not a member of this channel",
    };
  }

  // Cannot act on yourself (except mode_change)
  if (executorId === targetId && action !== "mode_change") {
    return {
      allowed: false,
      reason: "Cannot perform this action on yourself",
    };
  }

  // Owner can do anything
  if (executor.role === "owner") {
    return { allowed: true };
  }

  // Cannot act on owner
  if (target.role === "owner") {
    return {
      allowed: false,
      reason: "Cannot perform this action on the channel owner",
    };
  }

  // Role hierarchy: owner > admin > member > observer
  const roleHierarchy: Record<AgentChannelMemberRole, number> = {
    owner: 4,
    admin: 3,
    member: 2,
    observer: 1,
  };

  const executorLevel = roleHierarchy[executor.role];
  const targetLevel = roleHierarchy[target.role];

  // Can only act on lower roles
  if (executorLevel <= targetLevel) {
    return {
      allowed: false,
      reason: `Cannot perform this action on a ${target.role} (your role: ${executor.role})`,
    };
  }

  // Check specific permission for action
  const permissionMap: Record<typeof action, ChannelPermission> = {
    kick: "kick_agents",
    mute: "mute_agents",
    role_change: "manage_settings",
    mode_change: "manage_settings",
  };

  const requiredPermission = permissionMap[action];
  const hasPermission = hasChannelPermission(executor.role, requiredPermission);

  if (!hasPermission) {
    return {
      allowed: false,
      reason: `Missing permission: ${requiredPermission}`,
      requiredPermission,
      actualRole: executor.role,
    };
  }

  return { allowed: true };
}

/**
 * Check if an agent can send messages in a channel.
 */
export function canSendMessage(channel: AgentChannel, agentId: string): PermissionCheckResult {
  // Check if channel is archived
  if (channel.archived) {
    return {
      allowed: false,
      reason: "Cannot send messages to an archived channel",
    };
  }

  return checkPermission(channel, agentId, "send_messages");
}

/**
 * Check if an agent can create threads in a channel.
 */
export function canCreateThread(channel: AgentChannel, agentId: string): PermissionCheckResult {
  // Check channel settings
  if (channel.settings?.allowThreads === false) {
    return {
      allowed: false,
      reason: "Threads are disabled in this channel",
    };
  }

  return checkPermission(channel, agentId, "create_threads");
}

/**
 * Check if an agent can delete a message.
 */
export function canDeleteMessage(
  channel: AgentChannel,
  agentId: string,
  messageAuthorId: string,
): PermissionCheckResult {
  const member = channel.members.find((m) => m.agentId === agentId);

  if (!member) {
    return {
      allowed: false,
      reason: "Agent is not a member of this channel",
    };
  }

  // Can always delete own messages
  if (agentId === messageAuthorId) {
    return { allowed: true };
  }

  // Otherwise need delete_messages permission
  return checkPermission(channel, agentId, "delete_messages");
}

/**
 * Get all permissions for an agent in a channel.
 */
export function getAgentPermissions(channel: AgentChannel, agentId: string): ChannelPermission[] {
  const member = channel.members.find((m) => m.agentId === agentId);

  if (!member) {
    return [];
  }

  const rolePerms = ROLE_PERMISSIONS[member.role];
  if (rolePerms === "*") {
    return Object.values(ROLE_PERMISSIONS)
      .filter((p): p is ChannelPermission[] => Array.isArray(p))
      .flat();
  }

  return rolePerms;
}

/**
 * Check multiple permissions at once.
 */
export function checkPermissions(
  channel: AgentChannel,
  agentId: string,
  permissions: ChannelPermission[],
): Map<ChannelPermission, PermissionCheckResult> {
  const results = new Map<ChannelPermission, PermissionCheckResult>();

  for (const permission of permissions) {
    results.set(permission, checkPermission(channel, agentId, permission));
  }

  return results;
}

/**
 * Check if agent has any of the given permissions.
 */
export function hasAnyPermission(
  channel: AgentChannel,
  agentId: string,
  permissions: ChannelPermission[],
): boolean {
  return permissions.some((p) => checkPermission(channel, agentId, p).allowed);
}

/**
 * Check if agent has all of the given permissions.
 */
export function hasAllPermissions(
  channel: AgentChannel,
  agentId: string,
  permissions: ChannelPermission[],
): boolean {
  return permissions.every((p) => checkPermission(channel, agentId, p).allowed);
}

/**
 * Validate channel type access for an agent.
 */
export function canAccessChannel(channel: AgentChannel, agentId: string): PermissionCheckResult {
  const member = channel.members.find((m) => m.agentId === agentId);

  if (channel.type === "public") {
    // Anyone can access public channels, but must be member to interact
    return member ? { allowed: true } : { allowed: false, reason: "Not a member of this channel" };
  }

  if (channel.type === "private" || channel.type === "dm") {
    // Must be a member for private/DM channels
    if (!member) {
      return {
        allowed: false,
        reason: `Cannot access ${channel.type} channel without being a member`,
      };
    }
    return { allowed: true };
  }

  if (channel.type === "broadcast") {
    // Broadcast channels are typically read-only for non-admins
    if (!member) {
      return {
        allowed: false,
        reason: "Cannot access broadcast channel without being a member",
      };
    }
    return { allowed: true };
  }

  return { allowed: true };
}
