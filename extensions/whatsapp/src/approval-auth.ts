import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import { normalizeWhatsAppTarget } from "./normalize-target.js";

export function normalizeWhatsAppApproverId(value: string | number): string | undefined {
  const normalized = normalizeWhatsAppTarget(String(value));
  if (!normalized || normalized.endsWith("@g.us")) {
    return undefined;
  }
  return normalized;
}

function normalizeWhatsAppApproverEntry(value: string | number): string | undefined {
  return String(value).trim() === "*" ? "*" : normalizeWhatsAppApproverId(value);
}

type WhatsAppApprovalContext = Parameters<typeof resolveWhatsAppAccount>[0];

/** The explicitly configured approvers (`execApprovals.approvers`), or undefined when unset. */
function resolveExplicitWhatsAppApprovers(params: WhatsAppApprovalContext): string[] | undefined {
  const approvers = resolveWhatsAppAccount(params).execApprovals?.approvers;
  return approvers && approvers.length > 0 ? approvers.map(String) : undefined;
}

/**
 * Whether this account names its approvers separately from `allowFrom`. When it does, an approval
 * prompt is only delivered to a chat whose peer may approve it (see approval-native.ts).
 */
export function hasExplicitWhatsAppApprovers(params: WhatsAppApprovalContext): boolean {
  return resolveExplicitWhatsAppApprovers(params) !== undefined;
}

const whatsappApproval = createChannelApprovalAuth({
  channelLabel: "WhatsApp",
  resolveInputs: ({ cfg, accountId }) => {
    const account = resolveWhatsAppAccount({ cfg, accountId });
    // Named approvers replace the allow list as the approver set; who may message the agent
    // stays `allowFrom`.
    return { allowFrom: resolveExplicitWhatsAppApprovers({ cfg, accountId }) ?? account.allowFrom };
  },
  normalizeApprover: normalizeWhatsAppApproverEntry,
  normalizeSenderId: normalizeWhatsAppApproverId,
  isWildcardAuthorized: ({ purpose, approvers }) => purpose === "action" && approvers.includes("*"),
});

export const getWhatsAppApprovalApprovers = whatsappApproval.resolveApprovers;
export const whatsappApprovalAuth = whatsappApproval.approvalAuth;
