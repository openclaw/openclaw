import { formatAllowlistMatchMeta } from "openclaw/plugin-sdk/allow-from";
import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { shouldHandleTextCommands } from "openclaw/plugin-sdk/command-surface";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveDiscordGuildEntry, resolveDiscordMemberAccessState } from "./allow-list.js";
import {
  resolveDiscordDmCommandAccess,
  resolveDiscordTextCommandAccess,
} from "./dm-command-auth.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";
import { resolveDiscordPreflightChannelAccess } from "./message-handler.preflight-channel-access.js";
import { resolveDiscordPreflightChannelContext } from "./message-handler.preflight-channel-context.js";
import type {
  DiscordMessageEvent,
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";

type DiscordMessageAccessFacts = Pick<
  DiscordMessagePreflightContext,
  | "sender"
  | "memberRoleIds"
  | "messageChannelId"
  | "channelName"
  | "isGuildMessage"
  | "isDirectMessage"
  | "isGroupDm"
  | "threadChannel"
  | "threadParentId"
  | "threadParentName"
  | "hasControlCommand"
> & { guild?: DiscordMessageEvent["guild"]; guildId?: string; authorIsBot: boolean };
type DiscordMessageAccessPolicy = Pick<
  DiscordMessagePreflightParams,
  | "cfg"
  | "accountId"
  | "dmEnabled"
  | "groupDmEnabled"
  | "groupDmChannels"
  | "dmPolicy"
  | "groupPolicy"
  | "guildEntries"
  | "allowFrom"
> & { allowNameMatching: boolean };
type IngressOptions = Pick<
  Parameters<typeof resolveDiscordDmCommandAccess>[0],
  | "token"
  | "rest"
  | "contextBinding"
  | "childSessionPublication"
  | "conversationParentId"
  | "conversationThreadId"
>;

export type PreparedDiscordMessageAccess = Pick<
  DiscordMessagePreflightContext,
  | "guildInfo"
  | "channelConfig"
  | "threadName"
  | "displayChannelSlug"
  | "guildSlug"
  | "resolveChannelIngress"
> & {
  allowed: boolean;
  ingress: ResolvedChannelMessageIngress;
  allowTextCommands: boolean;
  displayChannelName?: string;
};

/** One access decision for receipt and admission; native identity/structure facts never refetch. */
async function resolveDiscordMessageAccess(
  facts: DiscordMessageAccessFacts,
  policy: DiscordMessageAccessPolicy,
  options: IngressOptions,
) {
  if ((facts.isDirectMessage && !policy.dmEnabled) || (facts.isGroupDm && !policy.groupDmEnabled)) {
    logVerbose("discord: drop message (direct/group dms disabled)");
    return null;
  }
  const guildInfo = facts.isGuildMessage
    ? resolveDiscordGuildEntry({
        guild: facts.guild ?? undefined,
        guildId: facts.guildId,
        guildEntries: policy.guildEntries,
      })
    : null;
  if (facts.isGuildMessage && Object.keys(policy.guildEntries ?? {}).length > 0 && !guildInfo) {
    logVerbose(`Blocked discord guild ${facts.guildId ?? "unknown"} (not in discord.guilds)`);
    return null;
  }
  const channel = resolveDiscordPreflightChannelContext({
    ...facts,
    guildName: facts.guild?.name,
    guildInfo,
  });
  if (
    !resolveDiscordPreflightChannelAccess({
      ...facts,
      ...channel,
      guildInfo,
      groupPolicy: policy.groupPolicy,
      groupDmChannels: policy.groupDmChannels,
      channelMatchMeta: formatAllowlistMatchMeta(channel.channelConfig),
    })
  ) {
    return null;
  }
  const member = resolveDiscordMemberAccessState({
    channelConfig: channel.channelConfig,
    guildInfo,
    sender: facts.sender,
    memberRoleIds: facts.memberRoleIds,
    allowNameMatching: policy.allowNameMatching,
  });
  if (facts.isGuildMessage && member.hasAccessRestrictions && !member.memberAllowed) {
    logVerbose("Blocked discord guild sender (not in users/roles allowlist)");
    return null;
  }
  const common = {
    ...options,
    accountId: policy.accountId,
    cfg: policy.cfg,
    sender: {
      id: facts.sender.id,
      name: facts.sender.name,
      tag: facts.sender.tag,
      isPluralKit: facts.sender.isPluralKit,
      authorKind: facts.authorIsBot ? ("bot" as const) : ("user" as const),
    },
    allowNameMatching: policy.allowNameMatching,
    conversationId: facts.messageChannelId,
  };
  const allowTextCommands = shouldHandleTextCommands({ cfg: policy.cfg, surface: "discord" });
  const ingress = facts.isDirectMessage
    ? await resolveDiscordDmCommandAccess({
        ...common,
        dmPolicy: policy.dmPolicy,
        configuredAllowFrom: policy.allowFrom ?? [],
      })
    : await resolveDiscordTextCommandAccess({
        ...common,
        ownerAllowFrom: policy.allowFrom,
        memberAccessConfigured: member.hasAccessRestrictions,
        memberAllowed: member.memberAllowed,
        allowTextCommands,
        hasControlCommand: facts.hasControlCommand,
      });
  return {
    ...channel,
    guildInfo,
    ingress,
    allowTextCommands,
    allowed: facts.isDirectMessage
      ? ingress.senderAccess.allowed
      : !ingress.commandAccess.shouldBlockControlCommand,
  };
}

/** Preflight retains facts; the same decision consumes live policy once when its turn starts. */
export async function prepareDiscordMessageAccess(
  preflight: DiscordMessagePreflightParams,
  facts: DiscordMessageAccessFacts,
): Promise<PreparedDiscordMessageAccess | null> {
  const receiptPolicy = {
    ...preflight,
    allowNameMatching: isDangerousNameMatchingEnabled(preflight.discordConfig),
  };
  const options = { token: preflight.token, rest: preflight.client.rest };
  const access = await resolveDiscordMessageAccess(facts, receiptPolicy, options);
  if (!access) {
    return null;
  }
  const readPolicy =
    preflight.readPolicy ??
    createDiscordLivePolicyReader({
      ...preflight,
      discordConfig: {
        ...preflight.discordConfig,
        dmPolicy: preflight.dmPolicy,
        allowFrom: preflight.allowFrom,
        guilds: preflight.guildEntries,
        dm: {
          ...preflight.discordConfig?.dm,
          enabled: preflight.dmEnabled,
          groupEnabled: preflight.groupDmEnabled,
          groupChannels: preflight.groupDmChannels,
        },
      },
      resolvedAllowlist: { guildEntries: preflight.guildEntries, allowFrom: preflight.allowFrom },
    });
  const assertCurrent = () => preflight.abortSignal?.throwIfAborted();
  return {
    ...access,
    resolveChannelIngress: async (
      contextBinding: ChannelIngressContextBinding,
      conversation?: { parentId?: string; threadId?: string },
    ) => {
      const resolved = await resolveDiscordMessageAccess(facts, receiptPolicy, {
        ...options,
        contextBinding,
        conversationParentId: conversation?.parentId,
        conversationThreadId: conversation?.threadId,
        childSessionPublication: {
          assertCurrent,
          prepare: async () =>
            (await resolveDiscordMessageAccess(facts, await readPolicy(), options))?.allowed
              ? assertCurrent
              : null,
        },
      });
      if (!resolved) {
        throw new Error("Discord source access changed during context construction");
      }
      return resolved.ingress;
    },
  };
}
