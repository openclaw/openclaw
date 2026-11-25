import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMSTeamsAccountConfig } from "./accounts.js";
import { normalizeMSTeamsMessagingTarget } from "./resolve-allowlist.js";

const MSTEAMS_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeMSTeamsApproverId(value: string | number): string | undefined {
  const normalized = normalizeMSTeamsMessagingTarget(String(value));
  const id = normalizeOptionalLowercaseString(
    normalized?.startsWith("user:") ? normalized.slice("user:".length) : normalized,
  );
  return id && MSTEAMS_ID_RE.test(id) ? id : undefined;
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
