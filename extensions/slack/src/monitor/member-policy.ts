import type { SlackMemberPolicyConfig } from "openclaw/plugin-sdk/config-contracts";
// Slack plugin module implements workspace member policy behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { SlackMonitorContext } from "./context.js";

export type SlackMemberPolicyDecision = { allowed: true } | { allowed: false; reason: string };

function isSlackUserLookupId(senderId: string): boolean {
  return /^[UW][A-Z0-9]+$/i.test(senderId.trim());
}

function resolveEnabledPolicy(
  policy: SlackMemberPolicyConfig | undefined,
): (Required<Omit<SlackMemberPolicyConfig, "teamId">> & { teamId?: string }) | null {
  if (policy?.enabled !== true) {
    return null;
  }
  return {
    enabled: true,
    teamId: policy.teamId?.trim() || undefined,
    requireWorkspaceTeam: policy.requireWorkspaceTeam ?? true,
    denyGuests: policy.denyGuests ?? true,
    denyExternal: policy.denyExternal ?? true,
    denyBots: policy.denyBots ?? true,
    denyDeleted: policy.denyDeleted ?? true,
  };
}

export async function authorizeSlackMemberPolicy(params: {
  ctx: SlackMonitorContext;
  senderId: string;
}): Promise<SlackMemberPolicyDecision> {
  const policy = resolveEnabledPolicy(params.ctx.memberPolicy);
  if (!policy) {
    return { allowed: true };
  }

  const senderId = params.senderId.trim();
  if (!isSlackUserLookupId(senderId)) {
    return policy.denyBots ? { allowed: false, reason: "sender-not-user" } : { allowed: true };
  }

  let user: Awaited<ReturnType<SlackMonitorContext["resolveUserAccess"]>>;
  try {
    user = await params.ctx.resolveUserAccess(senderId);
  } catch (error) {
    return {
      allowed: false,
      reason: `user-lookup-failed: ${formatErrorMessage(error)}`,
    };
  }

  if (policy.denyDeleted && user.deleted === true) {
    return { allowed: false, reason: "deleted-user" };
  }
  if (policy.denyBots && user.isBot === true) {
    return { allowed: false, reason: "bot-user" };
  }
  if (policy.denyGuests && (user.isRestricted === true || user.isUltraRestricted === true)) {
    return { allowed: false, reason: "guest-user" };
  }
  if (policy.denyExternal && user.isStranger === true) {
    return { allowed: false, reason: "external-user" };
  }

  const expectedTeamId = policy.teamId || params.ctx.teamId;
  if (policy.requireWorkspaceTeam && expectedTeamId && user.teamId !== expectedTeamId) {
    return { allowed: false, reason: "team-mismatch" };
  }
  if (policy.requireWorkspaceTeam && !expectedTeamId) {
    return { allowed: false, reason: "missing-workspace-team" };
  }

  return { allowed: true };
}
