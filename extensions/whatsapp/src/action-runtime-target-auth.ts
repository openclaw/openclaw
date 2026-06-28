// Whatsapp plugin module implements action runtime target auth behavior.
import { ToolAuthorizationError } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveWhatsAppAccount } from "./accounts.js";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";

export function resolveAuthorizedWhatsAppOutboundTarget(params: {
  cfg: OpenClawConfig;
  chatJid: string;
  accountId?: string;
  actionLabel: string;
}): { to: string; accountId: string } {
  const account = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const resolution = resolveWhatsAppOutboundTarget({
    to: params.chatJid,
    allowFrom: account.allowFrom ?? [],
    allowSendTo: account.allowSendTo,
    mode: "implicit",
  });
  if (!resolution.ok) {
    throw new ToolAuthorizationError(
      `WhatsApp ${params.actionLabel} blocked: chatJid "${params.chatJid}" is not allowed by the configured outbound policy for account "${account.accountId}".`,
    );
  }
  return { to: resolution.to, accountId: account.accountId };
}
