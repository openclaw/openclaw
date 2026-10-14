import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { normalizeNextcloudTalkAllowEntry } from "./policy.js";
import type { CoreConfig } from "./types.js";

function normalizeNextcloudTalkApproverId(value: string | number): string | undefined {
  return normalizeNextcloudTalkAllowEntry(String(value)) || undefined;
}

export const nextcloudTalkApprovalAuth = createChannelApprovalAuth({
  channelLabel: "Nextcloud Talk",
  resolveInputs: ({ cfg, accountId }) => {
    const account = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
    return { allowFrom: account.config.allowFrom };
  },
  normalizeApprover: normalizeNextcloudTalkApproverId,
}).approvalAuth;
