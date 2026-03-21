import type { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "openclaw/plugin-sdk/config-runtime";
import {
  loadSessionStore,
  resolveStorePath,
} from "../../../../../src/config/sessions.js";
import { resolveWhatsAppAccount } from "../../accounts.js";
} from "openclaw/plugin-sdk/config-runtime";
import { normalizeGroupActivation } from "openclaw/plugin-sdk/reply-runtime";

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
