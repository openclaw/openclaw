// Whatsapp plugin module implements approval auth behavior.
import {
  createChannelApprovalAuth,
  isImplicitSameChatApprovalAuthorization,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import { normalizeWhatsAppDirectPhone } from "./normalize-target.js";

function normalizeWhatsAppApproverId(value: string | number): string | undefined {
  return normalizeWhatsAppDirectPhone(String(value)) ?? undefined;
}

function normalizeWhatsAppApproverEntry(value: string | number): string | undefined {
  return String(value).trim() === "*" ? "*" : normalizeWhatsAppApproverId(value);
}

const whatsappApproval = createChannelApprovalAuth({
  channelLabel: "WhatsApp",
  resolveInputs: ({ cfg, accountId }) => {
    const account = resolveWhatsAppAccount({ cfg, accountId });
    // `defaultTo` owns delivery routing, not approval policy; inferring from it
    // would grant approval authority to a target that was never an operator.
    return { allowFrom: account.allowFrom };
  },
  normalizeApprover: normalizeWhatsAppApproverEntry,
  normalizeSenderId: normalizeWhatsAppApproverId,
  isWildcardAuthorized: ({ purpose, approvers }) => purpose === "action" && approvers.includes("*"),
});

export const getWhatsAppApprovalApprovers = whatsappApproval.resolveApprovers;
export const whatsappApprovalAuth = {
  authorizeActorAction(
    input: Parameters<typeof whatsappApproval.approvalAuth.authorizeActorAction>[0],
  ) {
    const result = whatsappApproval.approvalAuth.authorizeActorAction(input);
    if (!isImplicitSameChatApprovalAuthorization(result)) {
      return result;
    }
    const account = resolveWhatsAppAccount({ cfg: input.cfg, accountId: input.accountId });
    if (normalizeStringEntries(account.allowFrom ?? []).length === 0) {
      return result;
    }
    // A configured but unsupported allowlist must not collapse into the
    // no-allowlist same-chat fallback.
    return {
      authorized: false,
      reason: `❌ You are not authorized to approve ${input.approvalKind} requests on WhatsApp.`,
    } as const;
  },
};
