import { normalizeGroupActivation } from "../../../../../src/auto-reply/group-activation.js";
import type { loadConfig } from "../../../../../src/config/config.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../../../../../src/config/group-policy.js";
import {
  loadSessionStore,
  resolveStorePath,
} from "../../../../../src/config/sessions.js";
import { resolveWhatsAppAccount } from "../../accounts.js";

export function resolveGroupPolicyFor(
  cfg: ReturnType<typeof loadConfig>,
  conversationId: string,
  accountId?: string,
) {
  const groupId = conversationId?.trim();
  const whatsappCfg = resolveWhatsAppAccount({ cfg, accountId });
  const hasGroupAllowFrom = Boolean(
    whatsappCfg?.groupAllowFrom?.length || whatsappCfg?.allowFrom?.length,
  );
  return resolveChannelGroupPolicy({
    cfg,
    channel: "whatsapp",
    accountId,
    groupId: groupId ?? conversationId,
    hasGroupAllowFrom,
  });
}

export function resolveGroupRequireMentionFor(
  cfg: ReturnType<typeof loadConfig>,
  conversationId: string,
  accountId?: string,
) {
  const groupId = conversationId?.trim();
  return resolveChannelGroupRequireMention({
    cfg,
    channel: "whatsapp",
    accountId,
    groupId: groupId ?? conversationId,
  });
}

export function resolveGroupActivationFor(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  accountId?: string;
}) {
  const entry = loadSessionStore(
    resolveStorePath(params.cfg.session?.store, {
      agentId: params.agentId,
    }),
  )[params.sessionKey];
  const defaultActivation = !resolveGroupRequireMentionFor(
    params.cfg,
    params.conversationId,
    params.accountId,
  )
    ? "always"
    : "mention";
  return normalizeGroupActivation(entry?.groupActivation) ?? defaultActivation;
}
