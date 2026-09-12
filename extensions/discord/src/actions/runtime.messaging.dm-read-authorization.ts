import { ChannelType } from "discord-api-types/v10";
import { allowFromContainsDiscordUserId } from "../normalize.js";

export function readDiscordChannelRecipientIds(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const recipients = (value as Record<string, unknown>).recipients;
  if (!Array.isArray(recipients)) {
    return undefined;
  }
  const recipientIds: string[] = [];
  for (const recipient of recipients) {
    if (!recipient || typeof recipient !== "object") {
      return undefined;
    }
    const id = (recipient as Record<string, unknown>).id;
    if (typeof id !== "string" || !id.trim()) {
      return undefined;
    }
    recipientIds.push(id.trim());
  }
  return recipientIds;
}

export function isDiscordAllowlistedDirectMessage(params: {
  allowFrom: readonly string[];
  channelType?: number;
  guildId?: string;
  recipientIds?: string[];
}): boolean {
  if (
    params.guildId ||
    params.channelType !== ChannelType.DM ||
    params.recipientIds?.length !== 1
  ) {
    return false;
  }
  return allowFromContainsDiscordUserId(params.allowFrom, params.recipientIds[0]);
}
