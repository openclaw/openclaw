import {
  createResolvedApproverActionAuthAdapter,
} from "openclaw/plugin-sdk/approval-runtime";
import { getSlackExecApprovalApprovers } from "./exec-approvals.js";

export const slackApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Slack",
  resolveApprovers: ({ cfg, accountId }) => getSlackExecApprovalApprovers({ cfg, accountId }),
});
