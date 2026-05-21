import { mergeDiscordAccountConfig, resolveDefaultDiscordAccountId } from "../accounts.js";
import { createDiscordRuntimeAccountContext } from "../client.js";
import {
  isDiscordGroupAllowedByPolicy,
  resolveDiscordChannelConfig,
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
  assertReadTargetAllowed: (params: { guildId?: string; channelId: string }) => void;
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

function isDiscordReadTargetAllowedInGuild(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  guildInfo: DiscordGuildEntryResolved | null;
  channelId: string;
}): boolean {
  const channelConfig = resolveDiscordChannelConfig({
    guildInfo: params.guildInfo,
    channelId: params.channelId,
    channelSlug: params.channelId,
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
    assertReadTargetAllowed: ({ guildId, channelId }) => {
      const targetChannelId = discordMessagingActionRuntime.resolveDiscordChannelId(channelId);
      if (guildId) {
        const guildInfo = resolveDiscordActionGuildEntry({ guilds, guildId });
        if (
          !isDiscordReadTargetAllowedInGuild({
            groupPolicy,
            guildInfo,
            channelId: targetChannelId,
          })
        ) {
          throw new Error("Discord read target channel is not allowed.");
        }
        return;
      }
      if (!hasGuildEntries && groupPolicy !== "disabled" && groupPolicy !== "allowlist") {
        return;
      }
      const allowed = Object.values(guilds ?? {}).some((guildInfo) =>
        isDiscordReadTargetAllowedInGuild({
          groupPolicy,
          guildInfo: guildInfo ?? null,
          channelId: targetChannelId,
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
