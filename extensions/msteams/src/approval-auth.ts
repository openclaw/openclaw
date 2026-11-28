import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import type { ChannelDirectTargetResolution } from "openclaw/plugin-sdk/channel-contract";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMSTeamsAccountConfig } from "./accounts.js";
import { normalizeMSTeamsMessagingTarget, normalizeMSTeamsUserInput } from "./resolve-allowlist.js";

const MSTEAMS_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeMSTeamsApproverId(value: string | number): string | undefined {
  const normalized = normalizeMSTeamsMessagingTarget(String(value));
  const id = normalizeOptionalLowercaseString(
    normalized?.startsWith("user:") ? normalized.slice("user:".length) : normalized,
  );
  return id && MSTEAMS_ID_RE.test(id) ? id : undefined;
}

/**
 * Teams sends to `user:<id>` reuse or open the bot's 1:1 chat. Ids are Entra
 * object ids or Bot Framework `29:` user ids.
 */
export function resolveMSTeamsDirectTarget(params: {
  senderId: string;
}): ChannelDirectTargetResolution | undefined {
  const objectId = normalizeMSTeamsApproverId(params.senderId);
  if (objectId) {
    return { kind: "direct", to: `user:${objectId}` };
  }
  const userId = normalizeMSTeamsUserInput(params.senderId);
  return /^29:\S+$/.test(userId) ? { kind: "direct", to: `user:${userId}` } : undefined;
}

const msTeamsApproval = createChannelApprovalAuth({
  channelLabel: "Microsoft Teams",
  resolveInputs: ({ cfg, accountId }) => {
    const channel = resolveMSTeamsAccountConfig(cfg, accountId);
    return { allowFrom: channel?.allowFrom, defaultTo: channel?.defaultTo };
  },
  normalizeApprover: normalizeMSTeamsApproverId,
  normalizeSenderId: (value) => {
    const trimmed = normalizeOptionalLowercaseString(value);
    if (!trimmed) {
      return undefined;
    }
    return MSTEAMS_ID_RE.test(trimmed) ? trimmed : undefined;
  },
});

export const getMSTeamsApprovalApprovers = msTeamsApproval.resolveApprovers;
export const msTeamsApprovalAuth: typeof msTeamsApproval.approvalAuth = {
  authorizeActorAction(params) {
    const channel = params.cfg.channels?.msteams;
    if (
      !channel ||
      channel.enabled === false ||
      resolveMSTeamsAccountConfig(params.cfg, params.accountId).enabled === false
    ) {
      return {
        authorized: false,
        reason: "Microsoft Teams approval account is disabled or unavailable.",
      };
    }
    // Gateway settlement calls this owner again with current config. Return the
    // shared result intact so empty-approver same-chat authorization keeps its marker.
    return msTeamsApproval.approvalAuth.authorizeActorAction(params);
  },
};
