import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-runtime";
import { normalizeMatrixApproverId } from "./exec-approvals.js";
import { resolveMatrixAccount } from "./matrix/accounts.js";
import type { CoreConfig } from "./types.js";

export function getMatrixApprovalAuthApprovers(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): string[] {
  const account = resolveMatrixAccount(params);
  return resolveApprovalApprovers({
    allowFrom: account.config.dm?.allowFrom,
    normalizeApprover: normalizeMatrixApproverId,
  });
}

export const matrixApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Matrix",
  resolveApprovers: ({ cfg, accountId }) =>
    getMatrixApprovalAuthApprovers({ cfg: cfg as CoreConfig, accountId }),
  normalizeSenderId: (value) => normalizeMatrixApproverId(value),
});
