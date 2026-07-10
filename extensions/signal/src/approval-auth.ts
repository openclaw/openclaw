// Signal plugin module implements approval auth behavior.
import {
  createResolvedApproverActionAuthAdapter,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveSignalAccount } from "./accounts.js";
import { resolveSignalTarget } from "./aliases.js";
import { normalizeSignalMessagingTarget } from "./normalize.js";
import { looksLikeUuid } from "./uuid.js";

function normalizeSignalApproverId(value: string | number): string | undefined {
  const normalized = normalizeSignalMessagingTarget(String(value));
  if (!normalized || normalized.startsWith("group:") || normalized.startsWith("username:")) {
    return undefined;
  }
  if (looksLikeUuid(normalized)) {
    return `uuid:${normalized}`;
  }
  const e164 = normalizeE164(normalized);
  return e164.length > 1 ? e164 : undefined;
}

export function getSignalApprovalApprovers(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string | null;
}): string[] {
  const account = resolveSignalAccount(params).config;
  let defaultTo = account.defaultTo;
  if (typeof account.defaultTo === "string") {
    try {
      defaultTo =
        resolveSignalTarget({
          cfg: params.cfg,
          accountId: params.accountId,
          input: account.defaultTo,
        })?.to ?? account.defaultTo;
    } catch {
      defaultTo = account.defaultTo;
    }
  }
  return resolveApprovalApprovers({
    allowFrom: account.allowFrom,
    defaultTo,
    normalizeApprover: normalizeSignalApproverId,
  });
}

export const signalApprovalAuth = createResolvedApproverActionAuthAdapter({
  channelLabel: "Signal",
  resolveApprovers: getSignalApprovalApprovers,
  normalizeSenderId: (value) => normalizeSignalApproverId(value),
});
