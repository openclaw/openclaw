import type { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "openclaw/plugin-sdk/config-runtime";
import {
  loadSessionStore,
  resolveGroupSessionKey,
  resolveStorePath,
} from "openclaw/plugin-sdk/config-runtime";
import { normalizeGroupActivation } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAccountEntry } from "openclaw/plugin-sdk/routing";

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
  let hasGroupAllowFrom = false;
  const whatsappCfg = cfg.channels?.whatsapp as
    | {
        groupAllowFrom?: string[];
        allowFrom?: string[];
        accounts?: Record<string, { groupAllowFrom?: string[]; allowFrom?: string[] }>;
      }
    | undefined;
  if (whatsappCfg) {
    // Root-level
    hasGroupAllowFrom = Boolean(
      whatsappCfg.groupAllowFrom?.length || whatsappCfg.allowFrom?.length,
    );
    // Account-level (case-insensitive lookup — accountId is normalized to lowercase by routing)
    if (accountId && whatsappCfg.accounts) {
      const acctCfg = resolveAccountEntry(whatsappCfg.accounts, accountId);
      if (acctCfg) {
        hasGroupAllowFrom =
          hasGroupAllowFrom || Boolean(acctCfg.groupAllowFrom?.length || acctCfg.allowFrom?.length);
      }
    }
  }
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
  accountId?: string | null,
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
    accountId,
  });
}

export function resolveGroupActivationFor(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  accountId?: string | null;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];
  const requireMention = resolveGroupRequireMentionFor(
    params.cfg,
    params.conversationId,
    params.accountId,
  );
  const defaultActivation = !requireMention ? "always" : "mention";
  return normalizeGroupActivation(entry?.groupActivation) ?? defaultActivation;
}
