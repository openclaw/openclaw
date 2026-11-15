import type { SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";

export function buildSlackAccountSurfaceFields(config: SlackAccountConfig) {
  return {
    groupPolicy: config.groupPolicy,
    textChunkLimit: config.textChunkLimit,
    mediaMaxMb: config.mediaMaxMb,
    reactionNotifications: config.reactionNotifications,
    reactionAllowlist: config.reactionAllowlist,
    replyToMode: config.replyToMode,
    replyToModeByChatType: config.replyToModeByChatType,
    actions: config.actions,
    slashCommand: config.slashCommand,
    dm: config.dm,
    channels: config.channels,
  };
}

export type SlackAccountSurfaceFields = Partial<ReturnType<typeof buildSlackAccountSurfaceFields>>;
