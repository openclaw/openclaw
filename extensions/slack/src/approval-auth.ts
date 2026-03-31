import {
  createResolvedApproverActionAuthAdapter,
} from "openclaw/plugin-sdk/approval-runtime";
import {
  getSlackExecApprovalApprovers,
  normalizeSlackApproverId,
} from "./exec-approvals.js";

export const slackApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Slack",
  resolveApprovers: ({ cfg, accountId }) => getSlackExecApprovalApprovers({ cfg, accountId }),
  normalizeSenderId: (value) => normalizeSlackApproverId(value),
});
