import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
  resolveGroupSessionKey,
  type ChannelGroupPolicy,
  type GroupPolicy,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/config-runtime";
import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithCommandGate,
} from "openclaw/plugin-sdk/security-runtime";
import {
  resolveWhatsAppAccountPolicy,
  type ResolvedWhatsAppAccountPolicy,
} from "./account-policy.js";
import type { ResolvedWhatsAppAccount } from "./accounts.js";
import { getSelfIdentity, getSenderIdentity } from "./identity.js";
import type { WebInboundMessage } from "./inbound/types.js";
import { normalizeE164 } from "./text-runtime.js";

export type ResolvedWhatsAppInboundPolicy = ResolvedWhatsAppAccountPolicy & {
  resolveConversationGroupPolicy: (conversationId: string) => ChannelGroupPolicy;
  resolveConversationRequireMention: (conversationId: string) => boolean;
};

function resolveGroupConversationId(conversationId: string): string {
  return (
    resolveGroupSessionKey({
      From: conversationId,
      ChatType: "group",
      Provider: "whatsapp",
    })?.id ?? conversationId
  );
}

function buildResolvedWhatsAppGroupConfig(params: {
  groupPolicy: GroupPolicy;
  groups: ResolvedWhatsAppAccount["groups"];
}): OpenClawConfig {
  return {
    channels: {
      whatsapp: {
        groupPolicy: params.groupPolicy,
        groups: params.groups,
      },
    },
  } as OpenClawConfig;
}

export function resolveWhatsAppInboundPolicy(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  selfE164?: string | null;
}): ResolvedWhatsAppInboundPolicy {
  const policy = resolveWhatsAppAccountPolicy({
    cfg: params.cfg,
    accountId: params.accountId,
    selfE164: params.selfE164,
  });
  const resolvedGroupCfg = buildResolvedWhatsAppGroupConfig({
    groupPolicy: policy.groupPolicy,
    groups: policy.account.groups,
  });
  return {
    ...policy,
    resolveConversationGroupPolicy: (conversationId) =>
      resolveChannelGroupPolicy({
        cfg: resolvedGroupCfg,
        channel: "whatsapp",
        groupId: resolveGroupConversationId(conversationId),
        hasGroupAllowFrom: policy.groupAllowFrom.length > 0,
      }),
    resolveConversationRequireMention: (conversationId) =>
      resolveChannelGroupRequireMention({
        cfg: resolvedGroupCfg,
        channel: "whatsapp",
        groupId: resolveGroupConversationId(conversationId),
      }),
  };
}

export async function resolveWhatsAppCommandAuthorized(params: {
  cfg: OpenClawConfig;
  msg: WebInboundMessage;
  policy?: ResolvedWhatsAppInboundPolicy;
}): Promise<boolean> {
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  if (!useAccessGroups) {
    return true;
  }

  const self = getSelfIdentity(params.msg);
  const policy =
    params.policy ??
    resolveWhatsAppInboundPolicy({
      cfg: params.cfg,
      accountId: params.msg.accountId,
      selfE164: self.e164 ?? null,
    });
  const isGroup = params.msg.chatType === "group";
  const sender = getSenderIdentity(params.msg);
  const dmSender = sender.e164 ?? params.msg.from ?? "";
  const groupSender = sender.e164 ?? "";
  const normalizedSender = normalizeE164(isGroup ? groupSender : dmSender);
  if (!normalizedSender) {
    return false;
  }

  const storeAllowFrom =
    isGroup || !policy.shouldReadStorePairingApprovals
      ? []
      : await readStoreAllowFromForDmPolicy({
          provider: "whatsapp",
          accountId: policy.accountId,
          dmPolicy: policy.dmPolicy,
          shouldRead: policy.shouldReadStorePairingApprovals,
        });
  const access = resolveDmGroupAccessWithCommandGate({
    isGroup,
    dmPolicy: policy.dmPolicy,
    groupPolicy: policy.groupPolicy,
    allowFrom: policy.dmAllowFrom,
    groupAllowFrom: policy.groupAllowFrom,
    storeAllowFrom,
    isSenderAllowed: (allowEntries) =>
      isGroup
        ? policy.isGroupSenderAllowed(allowEntries, groupSender)
        : policy.isDmSenderAllowed(allowEntries, dmSender),
    command: {
      useAccessGroups,
      allowTextCommands: true,
      hasControlCommand: true,
    },
  });
  return access.commandAuthorized;
}
