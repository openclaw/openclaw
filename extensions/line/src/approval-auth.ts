// Line plugin module owns approval actor authorization for LINE accounts.
import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import { resolveLineAccount } from "./accounts.js";
import { inferLineTargetChatType, normalizeLineMessagingTarget } from "./messaging-target.js";

// A group id addresses a conversation, not an actor, so only user ids can approve.
// LINE admits DM principals without folding case (`normalizeStringEntries`), so this
// normalizer must not fold case either: an approver set that accepted a case variant
// the same allowlist refuses for delivery would authorize an unaddressable actor.
function normalizeLineApproverId(value: string | number): string | undefined {
  const id = normalizeLineMessagingTarget(String(value));
  return id && inferLineTargetChatType(id) === "direct" ? id : undefined;
}

const lineApproval = createChannelApprovalAuth({
  channelLabel: "LINE",
  resolveInputs: ({ cfg, accountId }) => ({
    allowFrom: resolveLineAccount({ cfg, ...(accountId ? { accountId } : {}) }).config.allowFrom,
  }),
  normalizeApprover: normalizeLineApproverId,
});

/** Approver user ids configured for one LINE account. */
export const getLineApprovalApprovers = lineApproval.resolveApprovers;
/** Approval actor authorization for the LINE channel plugin. */
export const lineApprovalAuth = lineApproval.approvalAuth;
