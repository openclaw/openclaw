import { mergeDiscordAccountConfig, resolveDefaultDiscordAccountId } from "../accounts.js";
import { createDiscordRuntimeAccountContext } from "../client.js";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordSlug,
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

function resolveDiscordActionGuildEntry(params: {
  guilds?: Record<string, DiscordGuildEntryResolved | undefined>;
  guildId?: string;
}): DiscordGuildEntryResolved | null {
  const guildId = params.guildId?.trim();
  if (!params.guilds) {
    return null;
  }
  if (guildId && params.guilds[guildId]) {
    return { ...params.guilds[guildId], id: guildId };
  }
  const wildcard = params.guilds["*"];
  return wildcard ? { ...wildcard, id: guildId } : null;
}

function hasAnyDiscordChannelAllowlist(
  guilds?: Record<string, DiscordGuildEntryResolved | undefined>,
): boolean {
  return Object.values(guilds ?? {}).some((guild) => hasDiscordGuildEntries(guild?.channels));
}

type DiscordReadTargetContext = {
  channelId: string;
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
    channelAllowed: channelConfig?.allowed !== false,
  });
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
  const hasGuildEntries = Boolean(guilds && Object.keys(guilds).length > 0);
  const groupPolicy =
    accountConfig.groupPolicy ??
    params.cfg.channels?.defaults?.groupPolicy ??
    (hasGuildEntries || hasAnyDiscordChannelAllowlist(guilds) ? "allowlist" : "open");
  const withOpts = (extra?: Record<string, unknown>) =>
    createDiscordActionOptions({ cfg: params.cfg, accountId, extra });
  const resolvedReactionAccountId = accountId ?? resolveDefaultDiscordAccountId(params.cfg);
  const reactionRuntimeOptions = resolvedReactionAccountId
    ? createDiscordRuntimeAccountContext({
        cfg: params.cfg,
        accountId: resolvedReactionAccountId,
      })
    : cfgOptions;
  const resolveReadTargetContext = async (channelId: string): Promise<DiscordReadTargetContext> => {
    const fallback: DiscordReadTargetContext = {
      channelId,
      channelSlug: normalizeDiscordSlug(channelId) || channelId,
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
    };
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
      if (!hasGuildEntries && groupPolicy !== "disabled" && groupPolicy !== "allowlist") {
        return;
      }
      const target = await resolveReadTargetContext(targetChannelId);
      if (guildId) {
        const guildInfo = resolveDiscordActionGuildEntry({ guilds, guildId });
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
        isDiscordReadTargetAllowedInGuild({
          groupPolicy,
          guildInfo: guildInfo ?? null,
          target,
        }),
      );
      if (!allowed) {
        throw new Error("Discord read target channel is not allowed.");
      }
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
