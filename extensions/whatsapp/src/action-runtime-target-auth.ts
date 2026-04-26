import { ToolAuthorizationError } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveWhatsAppDirectTargetAuthorization } from "./account-policy.js";

export function resolveAuthorizedWhatsAppOutboundTarget(params: {
  cfg: OpenClawConfig;
  chatJid: string;
  accountId?: string;
  actionLabel: string;
}): { to: string; accountId: string } {
  const authorized = resolveWhatsAppDirectTargetAuthorization({
    cfg: params.cfg,
    to: params.chatJid,
    accountId: params.accountId,
    mode: "implicit",
  });
  if (!authorized.resolution.ok) {
    throw new ToolAuthorizationError(
      `WhatsApp ${params.actionLabel} blocked: chatJid "${params.chatJid}" is not in the configured allowFrom list for account "${authorized.accountId}".`,
    );
  }
  return { to: authorized.resolution.to, accountId: authorized.accountId };
}
