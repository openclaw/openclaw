import { resolveWhatsAppAccount } from "./accounts.js";
import {
  ToolAuthorizationError,
  resolveWhatsAppOutboundTarget,
  type OpenClawConfig,
} from "./runtime-api.js";

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
      `WhatsApp ${params.actionLabel} blocked: chatJid "${params.chatJid}" is not in the configured allowSendTo/allowFrom list for account "${account.accountId}".`,
    );
  }
  return { to: resolution.to, accountId: account.accountId };
}
