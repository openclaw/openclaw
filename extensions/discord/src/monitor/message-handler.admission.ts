import type {
  ChannelIngressContextBinding,
  ResolveChannelMessageIngressParams,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { shouldHandleTextCommands } from "openclaw/plugin-sdk/command-surface";
import { resolveDiscordGuildEntry, resolveDiscordMemberAccessState } from "./allow-list.js";
import { resolveDiscordChannelNameSafe } from "./channel-access.js";
import {
  resolveDiscordDmCommandAccess,
  resolveDiscordTextCommandAccess,
} from "./dm-command-auth.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";
import type { DiscordChannelInfo } from "./message-channel-info.js";
import { resolveDiscordPreflightChannelAccess } from "./message-handler.preflight-channel-access.js";
import { resolveDiscordPreflightChannelContext } from "./message-handler.preflight-channel-context.js";
import { resolveDiscordPreflightThreadContext } from "./message-handler.preflight-thread.js";
import type {
  DiscordMessagePreflightParams,
  DiscordSenderIdentity,
} from "./message-handler.preflight.types.js";

type DiscordMessageSourceParams = {
  preflight: DiscordMessagePreflightParams;
  sender: DiscordSenderIdentity;
  messageChannelId: string;
  channelInfo: DiscordChannelInfo | null;
  isGuildMessage: boolean;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  hasControlCommand: boolean;
};

/** Receipt-time identity stays fixed; queued execution reacquires current account access. */
export function createDiscordMessageSourceAdmission(
  params: DiscordMessageSourceParams,
): NonNullable<ResolveChannelMessageIngressParams["childSessionPublication"]> {
  const { preflight, sender } = params;
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
  return {
    assertCurrent: () => preflight.abortSignal?.throwIfAborted(),
    prepare: async () => {
      const policy = await readPolicy();
      const senderFacts = {
        id: sender.id,
        name: sender.name,
        tag: sender.tag,
        isPluralKit: sender.isPluralKit,
        authorKind: preflight.data.author?.bot ? ("bot" as const) : ("user" as const),
      };
      const common = {
        accountId: preflight.accountId,
        cfg: policy.cfg,
        sender: senderFacts,
        allowNameMatching: policy.allowNameMatching,
        conversationId: params.messageChannelId,
      };
      if (params.isDirectMessage) {
        if (!policy.dmEnabled) {
          return null;
        }
        const access = await resolveDiscordDmCommandAccess({
          ...common,
          dmPolicy: policy.dmPolicy,
          configuredAllowFrom: policy.allowFrom,
          token: preflight.token,
          rest: preflight.client.rest,
        });
        if (!access.senderAccess.allowed) {
          return null;
        }
      } else {
        if (params.isGroupDm && !policy.groupDmEnabled) {
          return null;
        }
        const guildInfo = params.isGuildMessage
          ? resolveDiscordGuildEntry({
              guild: preflight.data.guild ?? undefined,
              guildId: preflight.data.guild_id ?? undefined,
              guildEntries: policy.guildEntries,
            })
          : null;
        if (
          params.isGuildMessage &&
          Object.keys(policy.guildEntries ?? {}).length > 0 &&
          !guildInfo
        ) {
          return null;
        }
        const thread = await resolveDiscordPreflightThreadContext({
          client: preflight.client,
          isGuildMessage: params.isGuildMessage,
          message: preflight.data.message,
          channelInfo: params.channelInfo,
          messageChannelId: params.messageChannelId,
          abortSignal: preflight.abortSignal,
        });
        if (!thread) {
          return null;
        }
        const channel = resolveDiscordPreflightChannelContext({
          isGuildMessage: params.isGuildMessage,
          messageChannelId: params.messageChannelId,
          channelName:
            params.channelInfo?.name ??
            resolveDiscordChannelNameSafe(
              "channel" in preflight.data.message ? preflight.data.message.channel : undefined,
            ),
          guildInfo,
          threadChannel: thread.earlyThreadChannel,
          threadParentId: thread.earlyThreadParentId,
          threadParentName: thread.earlyThreadParentName,
        });
        if (
          !resolveDiscordPreflightChannelAccess({
            ...params,
            ...channel,
            groupPolicy: policy.groupPolicy,
            groupDmChannels: policy.groupDmChannels,
            guildInfo,
            channelMatchMeta: "run admission",
          })
        ) {
          return null;
        }
        const member = resolveDiscordMemberAccessState({
          channelConfig: channel.channelConfig,
          guildInfo,
          memberRoleIds: Array.isArray(preflight.data.rawMember?.roles)
            ? preflight.data.rawMember.roles
            : [],
          sender,
          allowNameMatching: policy.allowNameMatching,
        });
        if (params.isGuildMessage && member.hasAccessRestrictions && !member.memberAllowed) {
          return null;
        }
        const access = await resolveDiscordTextCommandAccess({
          ...common,
          ownerAllowFrom: policy.allowFrom,
          memberAccessConfigured: member.hasAccessRestrictions,
          memberAllowed: member.memberAllowed,
          allowTextCommands: shouldHandleTextCommands({ cfg: policy.cfg, surface: "discord" }),
          hasControlCommand: params.hasControlCommand,
        });
        if (access.commandAccess.shouldBlockControlCommand) {
          return null;
        }
      }
      // A started ordinary request may finish after access changes; retain cancellation only.
      return () => preflight.abortSignal?.throwIfAborted();
    },
  };
}

/** Initial ingress and later admission keep the same Discord source and policy owners. */
export function createDiscordChannelMessageIngress(
  params: DiscordMessageSourceParams & {
    memberAccessConfigured: boolean;
    memberAllowed: boolean;
    allowNameMatching: boolean;
    allowTextCommands: boolean;
  },
) {
  const { preflight, sender } = params;
  return async (
    contextBinding?: ChannelIngressContextBinding,
    conversation?: { parentId?: string; threadId?: string },
  ) =>
    await resolveDiscordTextCommandAccess({
      accountId: preflight.accountId,
      cfg: preflight.cfg,
      ownerAllowFrom: preflight.allowFrom,
      sender: {
        id: sender.id,
        name: sender.name,
        tag: sender.tag,
        isPluralKit: sender.isPluralKit,
        authorKind: preflight.data.author?.bot ? "bot" : "user",
      },
      memberAccessConfigured: params.memberAccessConfigured,
      memberAllowed: params.memberAllowed,
      allowNameMatching: params.allowNameMatching,
      allowTextCommands: params.allowTextCommands,
      hasControlCommand: params.hasControlCommand,
      conversationId: params.messageChannelId,
      conversationParentId: conversation?.parentId,
      conversationThreadId: conversation?.threadId,
      ...(contextBinding ? { contextBinding } : {}),
      childSessionPublication: contextBinding
        ? createDiscordMessageSourceAdmission(params)
        : undefined,
    });
}
