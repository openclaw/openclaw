import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import type { ChannelDirectTargetResolution } from "openclaw/plugin-sdk/channel-contract";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGoogleChatAccount } from "./accounts.js";
import { isGoogleChatUserTarget, normalizeGoogleChatTarget } from "./targets.js";

export function normalizeGoogleChatApproverId(value: string | number): string | undefined {
  const normalized = normalizeGoogleChatTarget(String(value));
  if (!normalized || !isGoogleChatUserTarget(normalized)) {
    return undefined;
  }
  const suffix = normalizeLowercaseStringOrEmpty(normalized.slice("users/".length));
  if (!suffix || suffix.includes("@")) {
    return undefined;
  }
  return `users/${suffix}`;
}

/** Google Chat sends to a numeric `users/<id>` deliver to the app's existing DM space with that user. */
export function resolveGoogleChatDirectTarget(params: {
  senderId: string;
}): ChannelDirectTargetResolution | undefined {
  const to = normalizeGoogleChatApproverId(params.senderId);
  return to ? { kind: "direct", to } : undefined;
}

const googleChatApproval = createChannelApprovalAuth({
  channelLabel: "Google Chat",
  resolveInputs: ({ cfg, accountId }) => {
    const account = resolveGoogleChatAccount({ cfg, accountId }).config;
    return { allowFrom: account.allowFrom, defaultTo: account.defaultTo };
  },
  normalizeApprover: normalizeGoogleChatApproverId,
});

export const getGoogleChatApprovalApprovers = googleChatApproval.resolveApprovers;
export const googleChatApprovalAuth = googleChatApproval.approvalAuth;
