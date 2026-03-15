import { normalizeGroupActivation } from "../../../../../src/auto-reply/group-activation.js";
import type { loadConfig } from "../../../../../src/config/config.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../../../../../src/config/group-policy.js";
import {
  loadSessionStore,
  resolveGroupSessionKey,
  resolveStorePath,
} from "../../../../../src/config/sessions.js";
import { resolveAccountEntry } from "../../../../../src/routing/account-lookup.js";

export function resolveGroupPolicyFor(
  cfg: ReturnType<typeof loadConfig>,
  conversationId: string,
  accountId?: string | null,
) {
  const groupId = resolveGroupSessionKey({
    From: conversationId,
    ChatType: "group",
    Provider: "whatsapp",
  })?.id;
  const whatsappCfg = cfg.channels?.whatsapp as
    | {
        groupAllowFrom?: string[];
        allowFrom?: string[];
        accounts?: Record<string, { groupAllowFrom?: string[]; allowFrom?: string[] }>;
      }
    | undefined;
  const accountCfg = accountId ? resolveAccountEntry(whatsappCfg?.accounts, accountId) : undefined;
  const hasGroupAllowFrom = Boolean(
    accountCfg?.groupAllowFrom?.length ||
    accountCfg?.allowFrom?.length ||
    whatsappCfg?.groupAllowFrom?.length ||
    whatsappCfg?.allowFrom?.length,
  );
  return resolveChannelGroupPolicy({
    cfg,
    channel: "whatsapp",
    groupId: groupId ?? conversationId,
    accountId,
    hasGroupAllowFrom,
  });
}

export function resolveGroupRequireMentionFor(
  cfg: ReturnType<typeof loadConfig>,
  conversationId: string,
) {
  const groupId = resolveGroupSessionKey({
    From: conversationId,
    ChatType: "group",
    Provider: "whatsapp",
  })?.id;
  return resolveChannelGroupRequireMention({
    cfg,
    channel: "whatsapp",
    groupId: groupId ?? conversationId,
  });
}

export function resolveGroupActivationFor(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  sessionKey: string;
  conversationId: string;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];
  const requireMention = resolveGroupRequireMentionFor(params.cfg, params.conversationId);
  const defaultActivation = !requireMention ? "always" : "mention";
  return normalizeGroupActivation(entry?.groupActivation) ?? defaultActivation;
}
