import { ChannelType } from "discord-api-types/v10";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import type { ActionGate } from "openclaw/plugin-sdk/channel-actions";
import { readStringParam, withNormalizedTimestamp } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type {
  DiscordAccountConfig,
  DiscordActionConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { mergeDiscordAccountConfig, resolveDefaultDiscordAccountId } from "../accounts.js";
import { isDiscordThreadChannelType } from "../channel-type.js";
import { createDiscordRuntimeAccountContext } from "../client.js";
import {
  hasConfiguredDiscordChannels,
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordSlug,
  resolveGroupDmAllow,
  resolveDiscordChannelConfigWithFallback,
  type DiscordGuildEntryResolved,
} from "../monitor/allow-list.js";
import * as discordMessagingActionRuntime from "../send.js";
import { resolveDiscordTargetChannelId } from "../send.shared.js";
import type { DiscordReactOpts } from "../send.types.js";
import { parseDiscordTarget, resolveDiscordChannelId } from "../targets.js";
import {
  filterDiscordActiveThreadList,
  readDiscordChannelStringField,
  readDiscordChannelType,
  type DiscordReadAncestor,
  type DiscordReadTargetContext,
} from "./runtime.messaging.thread-list.js";
import { createDiscordActionOptions } from "./runtime.shared.js";

type ConversationReadInvocationOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;

export type DiscordMessagingActionOptions = {
  reply?: ChannelMessageActionContext["reply"];
  progressSnapshot?: ChannelMessageActionContext["progressSnapshot"];
  mediaAccess?: ChannelMessageActionContext["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  readContext?: {
    requesterAccountId?: string | null;
    currentChannelProvider?: string | null;
    currentChannelId?: string | null;
    currentChatType?: NonNullable<ChannelMessageActionContext["toolContext"]>["currentChatType"];
    currentMessagingTarget?: string | null;
  };
};

export type DiscordMessagingActionContext = {
  action: string;
  params: Record<string, unknown>;
  isActionEnabled: ActionGate<DiscordActionConfig>;
  cfg: OpenClawConfig;
  accountConfig: DiscordAccountConfig;
  options?: DiscordMessagingActionOptions;
  accountId?: string;
  resolveChannelId: () => string;
  assertReadTargetAllowed: (params: {
    guildId?: string;
    channelId: string;
    requireGuildMetadata?: boolean;
  }) => Promise<void>;
  assertGuildReadTargetAllowed: (params: {
    guildId: string;
    channelTargetRequiredMessage?: string;
    filteredResults?: boolean;
  }) => Promise<void>;
  filterActiveThreadList: (params: {
    guildId: string;
    channelId: string;
    value: unknown;
  }) => Promise<{ threads: unknown[]; members: unknown[] }>;
  filterGuildChannelList: <T>(params: { guildId: string; channels: T[] }) => Promise<T[]>;
  resolveReactionChannelId: () => Promise<string>;
  withOpts: (extra?: Record<string, unknown>) => { cfg: OpenClawConfig; accountId?: string };
  withReactionRuntimeOptions: <T extends Record<string, unknown> = Record<string, never>>(
    extra?: T,
  ) => DiscordReactOpts & T;
  normalizeMessage: (message: unknown) => unknown;
};

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
  if (guildId) {
    const guild =
      params.guilds[guildId] || Object.values(params.guilds).find((entry) => entry?.id === guildId);
    if (guild) {
      return { ...guild, id: guildId };
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

async function resolveDiscordReadAncestry(params: {
  channelId: string;
  parentId?: string;
  loadChannel: (channelId: string) => Promise<unknown>;
}): Promise<{ ancestors: DiscordReadAncestor[]; complete: boolean }> {
  const ancestors: DiscordReadAncestor[] = [];
  const visited = new Set([params.channelId]);
  let parentId = params.parentId;
  // Discord hierarchy is bounded at thread -> channel -> category. Preserve
  // that bound so malformed metadata cannot expand authorization-time I/O.
  for (let depth = 0; parentId && depth < 2; depth++) {
    if (visited.has(parentId)) {
      return { ancestors, complete: false };
    }
    visited.add(parentId);
    const parent = await params.loadChannel(parentId);
    if (!parent) {
      ancestors.push({
        channelId: parentId,
        channelSlug: normalizeDiscordSlug(parentId) || parentId,
      });
      return { ancestors, complete: false };
    }
    const parentName = readDiscordChannelStringField(parent, "name");
    ancestors.push({
      channelId: parentId,
      ...(parentName ? { channelName: parentName } : {}),
      channelSlug: parentName ? normalizeDiscordSlug(parentName) : parentId,
    });
    parentId = readDiscordChannelStringField(parent, "parent_id", "parentId");
  }
  return { ancestors, complete: !parentId };
}

async function buildDiscordReadTarget(params: {
  channelId: string;
  channelInfo: unknown;
  guildId?: string;
  fallbackSlug: string;
  loadChannel: (channelId: string) => Promise<unknown>;
}): Promise<DiscordReadTargetContext> {
  const channelName = readDiscordChannelStringField(params.channelInfo, "name");
  const channelType = readDiscordChannelType(params.channelInfo);
  const target: DiscordReadTargetContext = {
    channelId: params.channelId,
    channelSlug: channelName ? normalizeDiscordSlug(channelName) : params.fallbackSlug,
    metadataKnown: true,
    ancestryComplete: true,
    ancestors: [],
    ...(params.guildId ? { guildId: params.guildId } : {}),
    ...(channelName ? { channelName } : {}),
    ...(channelType !== undefined ? { channelType } : {}),
    ...(isDiscordThreadChannelType(channelType) ? { scope: "thread" as const } : {}),
  };
  const ancestry = await resolveDiscordReadAncestry({
    channelId: params.channelId,
    parentId: readDiscordChannelStringField(params.channelInfo, "parent_id", "parentId"),
    loadChannel: params.loadChannel,
  });
  target.ancestors = ancestry.ancestors;
  target.ancestryComplete = ancestry.complete;
  const immediateParent = target.ancestors[0];
  if (immediateParent) {
    target.parentId = immediateParent.channelId;
    if (immediateParent.channelName) {
      target.parentName = immediateParent.channelName;
    }
    target.parentSlug = immediateParent.channelSlug;
  }
  return target;
}

function isDiscordReadAncestryAllowed(params: {
  guildInfo: DiscordGuildEntryResolved | null;
  target: DiscordReadTargetContext;
}): boolean {
  for (const ancestor of params.target.ancestors) {
    const config = resolveDiscordChannelConfigWithFallback({
      guildInfo: params.guildInfo,
      channelId: ancestor.channelId,
      channelName: ancestor.channelName,
      channelSlug: ancestor.channelSlug,
    });
    if (config?.matchSource === "direct" && !config.allowed) {
      return false;
    }
  }
  return (
    params.target.ancestryComplete ||
    !hasExplicitlyDisabledDiscordChannels(params.guildInfo?.channels)
  );
}

function isDiscordReadTargetAllowedInGuild(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  guildInfo: DiscordGuildEntryResolved | null;
  target: DiscordReadTargetContext;
}): boolean {
  if (!params.target.metadataKnown) {
    if (hasExplicitlyDisabledDiscordChannels(params.guildInfo?.channels)) {
      return false;
    }
    const channelEntry = params.guildInfo?.channels?.[params.target.channelId];
    if (!channelEntry || channelEntry.enabled === false) {
      return false;
    }
  } else {
    if (!isDiscordReadAncestryAllowed(params)) {
      return false;
    }
    const channelConfig = resolveDiscordChannelConfigWithFallback({
      ...params.target,
      guildInfo: params.guildInfo,
    });
    if (channelConfig?.allowed === false) {
      return false;
    }
  }
  return isDiscordGroupAllowedByPolicy({
    groupPolicy: params.groupPolicy,
    guildAllowlisted: Boolean(params.guildInfo),
    channelAllowlistConfigured:
      !params.target.metadataKnown || hasConfiguredDiscordChannels(params.guildInfo?.channels),
    channelAllowed: true,
  });
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
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.discord !== undefined,
    groupPolicy: accountConfig.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  const directOperator = params.options?.conversationReadOrigin === "direct-operator";
  const currentReadContext = params.options?.readContext;
  const directDmEnabled =
    accountConfig.dm?.enabled !== false && (accountConfig.dmPolicy ?? "pairing") !== "disabled";
  const withOpts = (extra?: Record<string, unknown>) =>
    createDiscordActionOptions({ cfg: params.cfg, accountId, extra });
  const resolvedReactionAccountId = accountId ?? resolveDefaultDiscordAccountId(params.cfg);
  const isCurrentReadTarget = (channelId: string): boolean => {
    const requesterAccountId = currentReadContext?.requesterAccountId?.trim();
    const currentChannelId = currentReadContext?.currentChannelId?.trim();
    if (
      currentReadContext?.currentChannelProvider?.trim().toLowerCase() !== "discord" ||
      !requesterAccountId ||
      !currentChannelId ||
      normalizeAccountId(requesterAccountId) !== normalizeAccountId(resolvedReactionAccountId)
    ) {
      return false;
    }
    try {
      return resolveDiscordChannelId(currentChannelId) === channelId;
    } catch {
      return false;
    }
  };
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
    return named ?? resolveDiscordActionGuildEntry({ guilds, guildId });
  };
  const resolveReadTargetContext = async (channelId: string): Promise<DiscordReadTargetContext> => {
    const fallback: DiscordReadTargetContext = {
      channelId,
      channelSlug: normalizeDiscordSlug(channelId) || channelId,
      metadataKnown: false,
      ancestryComplete: false,
      ancestors: [],
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
    return buildDiscordReadTarget({
      channelId,
      channelInfo,
      guildId: readDiscordChannelStringField(channelInfo, "guild_id", "guildId"),
      fallbackSlug: fallback.channelSlug,
      loadChannel: async (parentId) => {
        try {
          return await discordMessagingActionRuntime.fetchChannelInfoDiscord(parentId, withOpts());
        } catch {
          return undefined;
        }
      },
    });
  };
  const isExpandedReadTargetEnabled = (
    guildInfo: DiscordGuildEntryResolved | null,
    target: DiscordReadTargetContext,
    currentConversation: boolean,
  ): boolean => {
    const groupDmEnabled =
      accountConfig.dm?.groupEnabled === true &&
      (currentConversation ||
        resolveGroupDmAllow({
          channels: accountConfig.dm?.groupChannels,
          channelId: target.channelId,
          channelName: target.channelName,
          channelSlug: target.channelSlug,
        }));
    if (!target.metadataKnown) {
      // Without provider metadata, the target might be a guild channel, DM, or
      // group DM. Every plausible scope must allow it before provider content reads.
      return (
        groupPolicy !== "disabled" &&
        directDmEnabled &&
        groupDmEnabled &&
        !Object.values(guilds ?? {}).some((guild) =>
          hasExplicitlyDisabledDiscordChannels(guild?.channels),
        )
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
    if (!isDiscordReadAncestryAllowed({ guildInfo, target })) {
      return false;
    }
    const channelConfig = resolveDiscordChannelConfigWithFallback({ ...target, guildInfo });
    return !channelConfig?.matchSource || channelConfig.allowed;
  };
  return {
    action: params.action,
    params: params.input,
    isActionEnabled: params.isActionEnabled,
    cfg: params.cfg,
    accountConfig,
    options: params.options,
    accountId,
    resolveChannelId: () =>
      resolveDiscordChannelId(
        readStringParam(params.input, "channelId", {
          required: true,
        }),
      ),
    assertReadTargetAllowed: async ({ guildId, channelId, requireGuildMetadata }) => {
      const targetChannelId = resolveDiscordChannelId(channelId);
      const target = await resolveReadTargetContext(targetChannelId);
      if (
        requireGuildMetadata &&
        (!guildId || !target.metadataKnown || target.guildId !== guildId)
      ) {
        throw new Error("Discord active thread parent metadata is unavailable.");
      }
      const currentConversation = isCurrentReadTarget(targetChannelId);
      if (guildId && target.metadataKnown && target.guildId !== guildId) {
        throw new Error("Discord read target channel is not allowed.");
      }
      const targetGuildId = guildId || target.guildId;
      const guildInfo = targetGuildId ? await resolveReadGuildEntry(targetGuildId) : null;
      // Known non-guild targets must never borrow a guild wildcard or channel
      // allowlist. Unknown metadata may use only the helper's fail-closed,
      // stable-ID path while every plausible non-guild scope remains enabled.
      const allowedWithoutGuild =
        !targetGuildId &&
        !target.metadataKnown &&
        Object.values(guilds ?? {}).some((candidateGuildInfo) =>
          isDiscordReadTargetAllowedInGuild({
            groupPolicy,
            guildInfo: candidateGuildInfo ?? null,
            target,
          }),
        );
      if (
        (directOperator && isExpandedReadTargetEnabled(guildInfo, target, false)) ||
        (currentConversation && isExpandedReadTargetEnabled(guildInfo, target, true))
      ) {
        return;
      }
      const allowed = targetGuildId
        ? isDiscordReadTargetAllowedInGuild({ groupPolicy, guildInfo, target })
        : allowedWithoutGuild;
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
        hasConfiguredDiscordChannels(guildInfo?.channels) &&
        !allowsAllDiscordGuildChannels(guildInfo.channels)
      ) {
        throw new Error(
          channelTargetRequiredMessage ??
            "Discord message search requires channelId or channelIds so each read target can be authorized.",
        );
      }
    },
    filterActiveThreadList: async ({ guildId, channelId, value }) => {
      const parent = await resolveReadTargetContext(channelId);
      if (!parent.metadataKnown || parent.guildId !== guildId) {
        throw new Error("Discord active thread parent metadata is unavailable.");
      }
      const guildInfo = await resolveReadGuildEntry(guildId);
      return filterDiscordActiveThreadList({
        value,
        guildId,
        channelId,
        parent,
        isAllowed: (target) =>
          (directOperator && isExpandedReadTargetEnabled(guildInfo, target, false)) ||
          (isCurrentReadTarget(target.channelId) &&
            isExpandedReadTargetEnabled(guildInfo, target, true)) ||
          isDiscordReadTargetAllowedInGuild({ groupPolicy, guildInfo, target }),
      });
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
      const visibleChannels: typeof channels = [];
      for (const channel of channels) {
        const channelId = readDiscordChannelStringField(channel, "id");
        if (!channelId) {
          continue;
        }
        const target = await buildDiscordReadTarget({
          channelId,
          channelInfo: channel,
          guildId,
          fallbackSlug: channelId,
          loadChannel: async (parentId) => channelById.get(parentId),
        });
        if (!isDiscordReadAncestryAllowed({ guildInfo, target })) {
          continue;
        }
        const channelConfig = resolveDiscordChannelConfigWithFallback({ ...target, guildInfo });
        if (!channelConfig?.matchSource || channelConfig.allowed) {
          visibleChannels.push(channel);
        }
      }
      return visibleChannels;
    },
    resolveReactionChannelId: async () => {
      const target =
        readStringParam(params.input, "channelId") ??
        readStringParam(params.input, "to", { required: true });
      if (params.action === "reactions" && !directOperator) {
        const reactionTarget = parseDiscordTarget(target, { defaultKind: "channel" });
        if (reactionTarget?.kind === "user" && currentReadContext?.currentChatType === "direct") {
          const currentTarget = parseDiscordTarget(
            currentReadContext.currentMessagingTarget ?? "",
            { defaultKind: "channel" },
          );
          if (currentTarget?.kind === "user" && currentTarget.id === reactionTarget.id) {
            const currentChannelId = resolveDiscordChannelId(
              currentReadContext.currentChannelId ?? "",
            );
            if (isCurrentReadTarget(currentChannelId)) {
              return currentChannelId;
            }
          }
        }
        // Resolving a user through the send path can create a DM before read policy runs.
        return resolveDiscordChannelId(target);
      }
      try {
        return resolveDiscordChannelId(target);
      } catch {
        return (
          await resolveDiscordTargetChannelId(target, {
            cfg: params.cfg,
            accountId: resolvedReactionAccountId,
          })
        ).channelId;
      }
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
