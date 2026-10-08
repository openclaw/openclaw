import type {
  AccessGroupMembershipFact,
  ChannelIngressEventInput,
  ChannelIngressContextBinding,
  IdentifierAuthentication,
  ChannelIngressIdentitySubjectInput,
  ResolveChannelMessageIngressParams,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { RequestClient } from "../internal/discord.js";
import { getDiscordRuntime } from "../runtime.js";
import { canViewDiscordGuildChannel } from "../send.permissions.js";
import { discordIngressIdentity } from "./ingress-identity.js";

const DISCORD_CHANNEL_ID = "discord";

export type DiscordDmPolicy = "open" | "pairing" | "allowlist" | "disabled";

type DiscordIngressSender = {
  id: string;
  name?: string;
  tag?: string;
  isPluralKit?: boolean;
  authorKind?: "user" | "bot";
};

type DiscordCommandAccessParams = {
  accountId: string;
  sender: DiscordIngressSender;
  allowNameMatching: boolean;
  cfg?: OpenClawConfig;
  token?: string;
  rest?: RequestClient;
  conversationId?: string;
  conversationParentId?: string;
  conversationThreadId?: string;
  contextBinding?: ChannelIngressContextBinding;
  minIdentifierAuthentication?: IdentifierAuthentication;
};

function createDiscordDmIngressSubject(
  sender: DiscordIngressSender,
): ChannelIngressIdentitySubjectInput {
  return {
    stableId: sender.id,
    aliases: {
      discordUserName: sender.name,
      discordUserTag: sender.tag,
      participantKind: sender.isPluralKit ? "pluralkit-member" : sender.authorKind,
    },
    // PluralKit replaces Discord's Gateway author id with a member id returned by
    // its API. The lookup is trusted input, but Discord did not bind that exact id.
    ...(sender.isPluralKit ? { authentication: { discordUserId: "asserted" as const } } : {}),
  };
}

function createDiscordDynamicAccessGroupResolver(params: {
  cfg?: OpenClawConfig;
  token?: string;
  rest?: RequestClient;
}): ResolveChannelMessageIngressParams["resolveAccessGroupMembership"] {
  if (!params.cfg) {
    return undefined;
  }
  const cfg = params.cfg;
  return async ({ name, group, accountId, subject }) => {
    if (group.type !== "discord.channelAudience") {
      return false;
    }
    const senderId = String(subject.stableId ?? "").trim();
    if (!senderId) {
      return false;
    }
    const membership = group.membership ?? "canViewChannel";
    if (membership !== "canViewChannel") {
      return false;
    }
    try {
      return await canViewDiscordGuildChannel(group.guildId, group.channelId, senderId, {
        cfg,
        accountId,
        token: params.token,
        rest: params.rest,
      });
    } catch (err) {
      logVerbose(`discord: accessGroup:${name} lookup failed for user ${senderId}: ${String(err)}`);
      throw err;
    }
  };
}

function createDiscordIngressResolver(params: {
  accountId: string;
  cfg?: OpenClawConfig;
  token?: string;
  rest?: RequestClient;
  readStoreAllowFrom?: ResolveChannelMessageIngressParams["readStoreAllowFrom"];
  useDefaultPairingStore?: boolean;
}) {
  return getDiscordRuntime().channel.inbound.ingress.createResolver({
    channelId: DISCORD_CHANNEL_ID,
    accountId: params.accountId,
    identity: discordIngressIdentity,
    cfg: params.cfg,
    resolveAccessGroupMembership: createDiscordDynamicAccessGroupResolver({
      cfg: params.cfg,
      token: params.token,
      rest: params.rest,
    }),
    ...(params.readStoreAllowFrom ? { readStoreAllowFrom: params.readStoreAllowFrom } : {}),
    ...(params.useDefaultPairingStore !== undefined
      ? { useDefaultPairingStore: params.useDefaultPairingStore }
      : {}),
  });
}

function createDiscordCommandContext(
  params: DiscordCommandAccessParams,
  kind: "direct" | "channel",
  defaultId: string,
) {
  return {
    subject: createDiscordDmIngressSubject(params.sender),
    conversation: {
      kind,
      id: params.conversationId ?? defaultId,
      parentId: params.conversationParentId,
      threadId: params.conversationThreadId,
    },
    ...(params.contextBinding ? { contextBinding: params.contextBinding } : {}),
    policy: {
      mutableIdentifierMatching: params.allowNameMatching
        ? ("enabled" as const)
        : ("disabled" as const),
      ...(params.minIdentifierAuthentication
        ? { minIdentifierAuthentication: params.minIdentifierAuthentication }
        : {}),
    },
  };
}

export async function resolveDiscordDmCommandAccess(
  params: DiscordCommandAccessParams & {
    dmPolicy: DiscordDmPolicy;
    configuredAllowFrom: string[];
    readStoreAllowFrom?: ResolveChannelMessageIngressParams["readStoreAllowFrom"];
    eventKind?: ChannelIngressEventInput["kind"];
  },
) {
  return await createDiscordIngressResolver({
    ...params,
    useDefaultPairingStore: params.readStoreAllowFrom == null,
  }).message({
    ...createDiscordCommandContext(params, "direct", params.sender.id),
    event: {
      kind: params.eventKind ?? "native-command",
      authMode: "inbound",
      mayPair: true,
    },
    dmPolicy: params.dmPolicy,
    groupPolicy: "disabled",
    allowFrom: params.configuredAllowFrom,
    command: {
      hasControlCommand: false,
      modeWhenAccessGroupsOff: "configured",
    },
  });
}

export async function resolveDiscordTextCommandAccess(
  params: DiscordCommandAccessParams & {
    ownerAllowFrom?: string[];
    memberAccessConfigured: boolean;
    memberAllowed: boolean;
    allowTextCommands: boolean;
    hasControlCommand: boolean;
  },
) {
  const ownerAllowFrom = (params.ownerAllowFrom ?? []).filter((entry) => entry.trim() !== "*");
  const memberAccessGroup = "discord-member-access";
  const commandGroup = params.memberAccessConfigured ? [`accessGroup:${memberAccessGroup}`] : [];
  const accessGroupMembership: AccessGroupMembershipFact[] = params.memberAccessConfigured
    ? [
        {
          groupName: memberAccessGroup,
          source: "dynamic",
          ...(params.memberAllowed
            ? ({ kind: "matched", matchedEntryIds: [memberAccessGroup] } as const)
            : ({ kind: "not-matched" } as const)),
        },
      ]
    : [];
  return await createDiscordIngressResolver(params).command({
    ...createDiscordCommandContext(params, "channel", "discord-command"),
    accessGroupMembership,
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    allowFrom: ownerAllowFrom,
    groupAllowFrom: commandGroup,
    command: {
      allowTextCommands: params.allowTextCommands,
      hasControlCommand: params.hasControlCommand,
      modeWhenAccessGroupsOff: "configured",
    },
  });
}
