import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import { normalizeMatrixApproverId } from "./approval-ids.js";
import { resolveDefaultMatrixAccountId, resolveMatrixAccountConfig } from "./matrix/accounts.js";

const matrixApproval = createChannelApprovalAuth({
  channelLabel: "Matrix",
  resolveInputs: ({ cfg, accountId }) => {
    const account = resolveMatrixAccountConfig({
      cfg,
      accountId: accountId ?? resolveDefaultMatrixAccountId(cfg),
    });
    return { allowFrom: account.dm?.allowFrom };
  },
  normalizeApprover: normalizeMatrixApproverId,
});

export const getMatrixApprovalAuthApprovers = matrixApproval.resolveApprovers;
export const matrixApprovalAuth = matrixApproval.approvalAuth;
