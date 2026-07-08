import { ChannelType } from "discord-api-types/v10";
import type { ConversationReadInvocationOrigin } from "openclaw/plugin-sdk/channel-contract";
// Discord plugin module implements runtime.messaging.shared behavior.
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { mergeDiscordAccountConfig, resolveDefaultDiscordAccountId } from "../accounts.js";
import { createDiscordRuntimeAccountContext } from "../client.js";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordSlug,
  resolveGroupDmAllow,
  resolveDiscordChannelConfigWithFallback,
  type DiscordGuildEntryResolved,
} from "../monitor/allow-list.js";
import {
  type ActionGate,
  readStringParam,
  type DiscordActionConfig,
  type OpenClawConfig,
  withNormalizedTimestamp,
} from "../runtime-api.js";
import type { DiscordReactOpts } from "../send.types.js";
import { discordMessagingActionRuntime } from "./runtime.messaging.runtime.js";
import { createDiscordActionOptions } from "./runtime.shared.js";

export type DiscordMessagingActionOptions = {
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
    workspaceDir?: string;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
};

export type DiscordMessagingActionContext = {
  action: string;
  params: Record<string, unknown>;
  isActionEnabled: ActionGate<DiscordActionConfig>;
  cfg: OpenClawConfig;
  options?: DiscordMessagingActionOptions;
  accountId?: string;
  resolveChannelId: () => string;
  assertReadTargetAllowed: (params: { guildId?: string; channelId: string }) => Promise<void>;
  assertGuildReadTargetAllowed: (params: {
    guildId: string;
    channelTargetRequiredMessage?: string;
    filteredResults?: boolean;
  }) => Promise<void>;
  filterGuildChannelList: <T>(params: { guildId: string; channels: T[] }) => Promise<T[]>;
  resolveReactionChannelId: () => Promise<string>;
  withOpts: (extra?: Record<string, unknown>) => { cfg: OpenClawConfig; accountId?: string };
  withReactionRuntimeOptions: <T extends Record<string, unknown> = Record<string, never>>(
    extra?: T,
  ) => DiscordReactOpts & T;
  normalizeMessage: (message: unknown) => unknown;
};

function hasDiscordGuildEntries(
  guilds: DiscordGuildEntryResolved["channels"] | undefined,
): guilds is NonNullable<DiscordGuildEntryResolved["channels"]> {
  return Boolean(guilds && Object.keys(guilds).length > 0);
}

function allowsAllDiscordGuildChannels(
  channels: DiscordGuildEntryResolved["channels"] | undefined,
): boolean {
  const wildcard = channels?.["*"];
  if (!wildcard || wildcard.enabled === false) {
    return false;
  }
  return Object.values(channels ?? {}).every((entry) => entry?.enabled !== false);
}

function resolveDiscordActionGuildEntry(params: {
  guilds?: Record<string, DiscordGuildEntryResolved | undefined>;
  guildId?: string;
  guildName?: string;
  includeWildcard?: boolean;
}): DiscordGuildEntryResolved | null {
  const guildId = params.guildId?.trim();
  if (!params.guilds) {
    return null;
  }
  if (guildId && params.guilds[guildId]) {
    return { ...params.guilds[guildId], id: guildId };
  }
  if (guildId) {
    const byConfiguredId = Object.values(params.guilds).find((guild) => guild?.id === guildId);
    if (byConfiguredId) {
      return { ...byConfiguredId, id: guildId };
    }
  }
  const guildSlug = params.guildName ? normalizeDiscordSlug(params.guildName) : "";
  if (guildSlug) {
    const bySlug =
      params.guilds[guildSlug] ??
      Object.values(params.guilds).find((guild) => guild?.slug === guildSlug);
    if (bySlug) {
      return { ...bySlug, id: guildId, slug: guildSlug || bySlug.slug };
    }
  }
  if (params.includeWildcard === false) {
    return null;
  }
  const wildcard = params.guilds["*"];
  return wildcard ? { ...wildcard, id: guildId } : null;
}

type DiscordReadTargetContext = {
  channelId: string;
  metadataKnown: boolean;
  channelType?: number;
  guildId?: string;
  channelName?: string;
  channelSlug: string;
  parentId?: string;
  parentName?: string;
  parentSlug?: string;
  scope?: "channel" | "thread";
};

function readDiscordChannelStringField(value: unknown, ...keys: string[]): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function readDiscordChannelType(value: unknown): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const type = (value as Record<string, unknown>).type;
  return typeof type === "number" ? type : undefined;
}

function isDiscordThreadChannel(value: unknown): boolean {
  const type = readDiscordChannelType(value);
  return type === 10 || type === 11 || type === 12;
}

function isDiscordReadTargetAllowedInGuild(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  guildInfo: DiscordGuildEntryResolved | null;
  target: DiscordReadTargetContext;
}): boolean {
  const channelConfig = resolveDiscordChannelConfigWithFallback({
    guildInfo: params.guildInfo,
    channelId: params.target.channelId,
    channelName: params.target.channelName,
    channelSlug: params.target.channelSlug,
    parentId: params.target.parentId,
    parentName: params.target.parentName,
    parentSlug: params.target.parentSlug,
    scope: params.target.scope,
  });
  if (channelConfig?.allowed === false) {
    return false;
  }
  return isDiscordGroupAllowedByPolicy({
    groupPolicy: params.groupPolicy,
    guildAllowlisted: Boolean(params.guildInfo),
    channelAllowlistConfigured: hasDiscordGuildEntries(params.guildInfo?.channels),
    channelAllowed: true,
  });
}

function isDiscordReadTargetExplicitlyAllowedById(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  guildInfo: DiscordGuildEntryResolved | null;
  target: DiscordReadTargetContext;
}): boolean {
  const channelEntry = params.guildInfo?.channels?.[params.target.channelId];
  if (!channelEntry || channelEntry.enabled === false) {
    return false;
  }
  return isDiscordGroupAllowedByPolicy({
    groupPolicy: params.groupPolicy,
    guildAllowlisted: Boolean(params.guildInfo),
    channelAllowlistConfigured: true,
    channelAllowed: true,
  });
}

function hasExplicitlyDisabledDiscordChannelConfig(
  guilds: Record<string, DiscordGuildEntryResolved | undefined> | undefined,
): boolean {
  return Object.values(guilds ?? {}).some((guild) =>
    hasExplicitlyDisabledDiscordChannels(guild?.channels),
  );
}

function hasExplicitlyDisabledDiscordChannels(
  channels: DiscordGuildEntryResolved["channels"] | undefined,
): boolean {
  return Object.values(channels ?? {}).some((channel) => channel.enabled === false);
}

export function createDiscordMessagingActionContext(params: {
  action: string;
  input: Record<string, unknown>;
  isActionEnabled: ActionGate<DiscordActionConfig>;
  cfg: OpenClawConfig;
  options?: DiscordMessagingActionOptions;
}): DiscordMessagingActionContext {
  const accountId = readStringParam(params.input, "accountId");
  const cfgOptions = { cfg: params.cfg };
  const accountConfig = mergeDiscordAccountConfig(
    params.cfg,
    accountId ?? resolveDefaultDiscordAccountId(params.cfg),
  );
  const guilds = accountConfig.guilds as Record<string, DiscordGuildEntryResolved | undefined>;
  const hasGuildEntries = Object.keys(guilds ?? {}).length > 0;
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.discord !== undefined,
    groupPolicy: accountConfig.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  const directOperator = params.options?.conversationReadOrigin === "direct-operator";
  const directDmEnabled =
    accountConfig.dm?.enabled !== false &&
    (accountConfig.dmPolicy ?? accountConfig.dm?.policy ?? "pairing") !== "disabled";
  const withOpts = (extra?: Record<string, unknown>) =>
    createDiscordActionOptions({ cfg: params.cfg, accountId, extra });
  const resolvedReactionAccountId = accountId ?? resolveDefaultDiscordAccountId(params.cfg);
  const reactionRuntimeOptions = resolvedReactionAccountId
    ? createDiscordRuntimeAccountContext({
        cfg: params.cfg,
        accountId: resolvedReactionAccountId,
      })
    : cfgOptions;
  const guildNameById = new Map<string, string | null>();
  const resolveGuildName = async (guildId: string): Promise<string | null> => {
    if (guildNameById.has(guildId)) {
      return guildNameById.get(guildId) ?? null;
    }
    try {
      const guildInfo = await discordMessagingActionRuntime.fetchGuildInfoDiscord(
        guildId,
        withOpts(),
      );
      const guildName = readDiscordChannelStringField(guildInfo, "name") ?? null;
      guildNameById.set(guildId, guildName);
      return guildName;
    } catch {
      guildNameById.set(guildId, null);
      return null;
    }
  };
  const resolveReadGuildEntry = async (
    guildId?: string,
  ): Promise<DiscordGuildEntryResolved | null> => {
    const direct = resolveDiscordActionGuildEntry({
      guilds,
      guildId,
      includeWildcard: false,
    });
    if (direct || !guildId) {
      return direct;
    }
    const guildName = await resolveGuildName(guildId);
    const named = resolveDiscordActionGuildEntry({
      guilds,
      guildId,
      guildName: guildName ?? undefined,
      includeWildcard: false,
    });
    if (named) {
      return named;
    }
    return resolveDiscordActionGuildEntry({ guilds, guildId });
  };
  const resolveReadTargetContext = async (channelId: string): Promise<DiscordReadTargetContext> => {
    const fallback: DiscordReadTargetContext = {
      channelId,
      channelSlug: normalizeDiscordSlug(channelId) || channelId,
      metadataKnown: false,
    };
    let channelInfo: unknown;
    try {
      channelInfo = await discordMessagingActionRuntime.fetchChannelInfoDiscord(
        channelId,
        withOpts(),
      );
    } catch {
      return fallback;
    }
    const channelName = readDiscordChannelStringField(channelInfo, "name");
    const target: DiscordReadTargetContext = {
      channelId,
      channelSlug: channelName ? normalizeDiscordSlug(channelName) : fallback.channelSlug,
      metadataKnown: true,
    };
    const channelType = readDiscordChannelType(channelInfo);
    if (channelType !== undefined) {
      target.channelType = channelType;
    }
    const targetGuildId = readDiscordChannelStringField(channelInfo, "guild_id", "guildId");
    if (targetGuildId) {
      target.guildId = targetGuildId;
    }
    if (channelName) {
      target.channelName = channelName;
    }
    if (!isDiscordThreadChannel(channelInfo)) {
      return target;
    }
    target.scope = "thread";
    target.parentId = readDiscordChannelStringField(channelInfo, "parent_id", "parentId");
    if (!target.parentId) {
      return target;
    }
    try {
      const parentInfo = await discordMessagingActionRuntime.fetchChannelInfoDiscord(
        target.parentId,
        withOpts(),
      );
      const parentName = readDiscordChannelStringField(parentInfo, "name");
      if (parentName) {
        target.parentName = parentName;
        target.parentSlug = normalizeDiscordSlug(parentName);
      }
    } catch {
      // Parent id fallback is enough for allowlist checks when the parent fetch is unavailable.
    }
    return target;
  };
  const isDirectReadTargetEnabled = (
    guildInfo: DiscordGuildEntryResolved | null,
    target: DiscordReadTargetContext,
  ): boolean => {
    const groupDmEnabled =
      accountConfig.dm?.groupEnabled === true &&
      resolveGroupDmAllow({
        channels: accountConfig.dm?.groupChannels,
        channelId: target.channelId,
        channelName: target.channelName,
        channelSlug: target.channelSlug,
      });
    if (!target.metadataKnown) {
      // Without provider metadata, the target might be a guild channel, DM, or
      // group DM. Every plausible scope must allow it before provider content reads.
      return (
        groupPolicy !== "disabled" &&
        directDmEnabled &&
        groupDmEnabled &&
        !hasExplicitlyDisabledDiscordChannelConfig(guilds)
      );
    }
    if (!target.guildId) {
      if (target.channelType === ChannelType.GroupDM) {
        return groupDmEnabled;
      }
      if (target.channelType === ChannelType.DM) {
        return directDmEnabled;
      }
      return directDmEnabled && groupDmEnabled;
    }
    if (groupPolicy === "disabled") {
      return false;
    }
    const channelConfig = resolveDiscordChannelConfigWithFallback({
      guildInfo,
      channelId: target.channelId,
      channelName: target.channelName,
      channelSlug: target.channelSlug,
      parentId: target.parentId,
      parentName: target.parentName,
      parentSlug: target.parentSlug,
      scope: target.scope,
    });
    return !channelConfig?.matchSource || channelConfig.allowed;
  };
  return {
    action: params.action,
    params: params.input,
    isActionEnabled: params.isActionEnabled,
    cfg: params.cfg,
    options: params.options,
    accountId,
    resolveChannelId: () =>
      discordMessagingActionRuntime.resolveDiscordChannelId(
        readStringParam(params.input, "channelId", {
          required: true,
        }),
      ),
    assertReadTargetAllowed: async ({ guildId, channelId }) => {
      const targetChannelId = discordMessagingActionRuntime.resolveDiscordChannelId(channelId);
      if (
        !directOperator &&
        !hasGuildEntries &&
        groupPolicy !== "disabled" &&
        groupPolicy !== "allowlist"
      ) {
        return;
      }
      const target = await resolveReadTargetContext(targetChannelId);
      if (guildId) {
        if (target.guildId && target.guildId !== guildId) {
          throw new Error("Discord read target channel is not allowed.");
        }
        const guildInfo = await resolveReadGuildEntry(guildId);
        if (directOperator && isDirectReadTargetEnabled(guildInfo, target)) {
          return;
        }
        if (
          !isDiscordReadTargetAllowedInGuild({
            groupPolicy,
            guildInfo,
            target,
          })
        ) {
          throw new Error("Discord read target channel is not allowed.");
        }
        return;
      }
      if (target.guildId) {
        const guildInfo = await resolveReadGuildEntry(target.guildId);
        if (directOperator && isDirectReadTargetEnabled(guildInfo, target)) {
          return;
        }
        if (
          !isDiscordReadTargetAllowedInGuild({
            groupPolicy,
            guildInfo,
            target,
          })
        ) {
          throw new Error("Discord read target channel is not allowed.");
        }
        return;
      }
      const allowed = Object.values(guilds ?? {}).some((guildInfo) =>
        isDiscordReadTargetExplicitlyAllowedById({
          groupPolicy,
          guildInfo: guildInfo ?? null,
          target,
        }),
      );
      if (directOperator && isDirectReadTargetEnabled(null, target)) {
        return;
      }
      if (!allowed) {
        throw new Error("Discord read target channel is not allowed.");
      }
    },
    assertGuildReadTargetAllowed: async ({
      guildId,
      channelTargetRequiredMessage,
      filteredResults,
    }) => {
      const guildInfo = await resolveReadGuildEntry(guildId);
      if (
        directOperator &&
        groupPolicy !== "disabled" &&
        (filteredResults === true || !hasExplicitlyDisabledDiscordChannels(guildInfo?.channels))
      ) {
        return;
      }
      if (
        !isDiscordGroupAllowedByPolicy({
          groupPolicy,
          guildAllowlisted: Boolean(guildInfo),
          channelAllowlistConfigured: false,
          channelAllowed: true,
        })
      ) {
        throw new Error("Discord read target channel is not allowed.");
      }
      if (
        hasDiscordGuildEntries(guildInfo?.channels) &&
        !allowsAllDiscordGuildChannels(guildInfo.channels)
      ) {
        throw new Error(
          channelTargetRequiredMessage ??
            "Discord message search requires channelId or channelIds so each read target can be authorized.",
        );
      }
    },
    filterGuildChannelList: async ({ guildId, channels }) => {
      if (!directOperator) {
        return channels;
      }
      const guildInfo = await resolveReadGuildEntry(guildId);
      const channelById = new Map(
        channels.flatMap((channel) => {
          const channelId = readDiscordChannelStringField(channel, "id");
          return channelId ? [[channelId, channel] as const] : [];
        }),
      );
      return channels.filter((channel) => {
        const channelId = readDiscordChannelStringField(channel, "id");
        if (!channelId) {
          return false;
        }
        const channelName = readDiscordChannelStringField(channel, "name");
        const parentId = readDiscordChannelStringField(channel, "parent_id", "parentId");
        const parent = parentId ? channelById.get(parentId) : undefined;
        const parentName = readDiscordChannelStringField(parent, "name");
        const channelConfig = resolveDiscordChannelConfigWithFallback({
          guildInfo,
          channelId,
          channelName,
          channelSlug: channelName ? normalizeDiscordSlug(channelName) : channelId,
          parentId,
          parentName,
          parentSlug: parentName ? normalizeDiscordSlug(parentName) : undefined,
          scope: isDiscordThreadChannel(channel) ? "thread" : undefined,
        });
        return !channelConfig?.matchSource || channelConfig.allowed;
      });
    },
    resolveReactionChannelId: async () => {
      const target =
        readStringParam(params.input, "channelId") ??
        readStringParam(params.input, "to", { required: true });
      return await discordMessagingActionRuntime.resolveDiscordReactionTargetChannelId({
        target,
        cfg: params.cfg,
        accountId: resolvedReactionAccountId,
      });
    },
    withOpts,
    withReactionRuntimeOptions: (extra) =>
      ({
        ...(reactionRuntimeOptions ?? cfgOptions),
        ...extra,
      }) as DiscordReactOpts & NonNullable<typeof extra>,
    normalizeMessage: (message: unknown) => {
      if (!message || typeof message !== "object") {
        return message;
      }
      return withNormalizedTimestamp(
        message as Record<string, unknown>,
        (message as { timestamp?: unknown }).timestamp,
      );
    },
  };
}
