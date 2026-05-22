import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import { normalizeWhatsAppTarget } from "./normalize.js";

export function normalizeWhatsAppApproverId(value: string | number): string | undefined {
  const normalized = normalizeWhatsAppTarget(String(value));
  if (!normalized || normalized.endsWith("@g.us")) {
    return undefined;
  }
  return normalized;
}

export function getWhatsAppApprovalApprovers(params: {
  cfg: Parameters<typeof resolveWhatsAppAccount>[0]["cfg"];
  accountId?: string | null;
}): string[] {
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId });
  return resolveApprovalApprovers({
    allowFrom: account.allowFrom,
    defaultTo: account.defaultTo,
    normalizeApprover: normalizeWhatsAppApproverId,
  });
}

export const whatsappApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "WhatsApp",
  resolveApprovers: getWhatsAppApprovalApprovers,
  normalizeSenderId: (value) => normalizeWhatsAppApproverId(value),
});
