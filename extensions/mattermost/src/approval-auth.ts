import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-runtime";
import { resolveMattermostAccount } from "./mattermost/accounts.js";

const MATTERMOST_USER_ID_RE = /^[a-z0-9]{26}$/;

function normalizeMattermostApproverId(value: string | number): string | undefined {
  const normalized = String(value)
    .trim()
    .replace(/^(mattermost|user):/i, "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
  return MATTERMOST_USER_ID_RE.test(normalized) ? normalized : undefined;
}

export const mattermostApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Mattermost",
  resolveApprovers: ({ cfg, accountId }) => {
    const account = resolveMattermostAccount({ cfg, accountId }).config;
    return resolveApprovalApprovers({
      allowFrom: account.allowFrom,
      normalizeApprover: normalizeMattermostApproverId,
    });
  },
  normalizeSenderId: (value) => normalizeMattermostApproverId(value),
});
