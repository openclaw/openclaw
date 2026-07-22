// Mattermost plugin module implements approval auth behavior.
import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMattermostAccount } from "./mattermost/accounts.js";

const MATTERMOST_USER_ID_RE = /^[a-z0-9]{26}$/;

function normalizeMattermostApproverId(value: string | number): string | undefined {
  const normalized = String(value)
    .trim()
    .replace(/^(mattermost|user):/i, "")
    .replace(/^@/, "")
    .trim();
  const lowered = normalizeLowercaseStringOrEmpty(normalized);
  return MATTERMOST_USER_ID_RE.test(lowered) ? lowered : undefined;
}

export const mattermostApprovalAuth = {
  ...createChannelApprovalAuth({
    channelLabel: "Mattermost",
    resolveInputs: ({ cfg, accountId }) => {
      const account = resolveMattermostAccount({ cfg, accountId }).config;
      return { allowFrom: account.allowFrom };
    },
    normalizeApprover: normalizeMattermostApproverId,
  }).approvalAuth,
  // Mattermost has no render adapter, so approval text comes from the
  // forwarder fallback, but its server renders markdown. Without this the
  // plaintext default would strip a code block users see today.
  approvalText: "markdown" as const,
};
