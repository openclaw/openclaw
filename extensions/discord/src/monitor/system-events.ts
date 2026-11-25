import { type Message, MessageType } from "../internal/discord.js";
import { formatDiscordUserTag } from "./format.js";

const SYSTEM_EVENT_ACTIONS = new Map<MessageType, string>([
  [MessageType.ChannelPinnedMessage, "pinned a message"],
  [MessageType.RecipientAdd, "added a recipient"],
  [MessageType.RecipientRemove, "removed a recipient"],
  [MessageType.UserJoin, "user joined"],
  [MessageType.GuildBoost, "boosted the server"],
  [MessageType.GuildBoostTier1, "boosted the server (Tier 1 reached)"],
  [MessageType.GuildBoostTier2, "boosted the server (Tier 2 reached)"],
  [MessageType.GuildBoostTier3, "boosted the server (Tier 3 reached)"],
  [MessageType.ThreadCreated, "created a thread"],
  [MessageType.AutoModerationAction, "auto moderation action"],
  [MessageType.GuildIncidentAlertModeEnabled, "raid protection enabled"],
  [MessageType.GuildIncidentAlertModeDisabled, "raid protection disabled"],
  [MessageType.GuildIncidentReportRaid, "raid reported"],
  [MessageType.GuildIncidentReportFalseAlarm, "raid report marked false alarm"],
  [MessageType.StageStart, "stage started"],
  [MessageType.StageEnd, "stage ended"],
  [MessageType.StageSpeaker, "stage speaker updated"],
  [MessageType.StageTopic, "stage topic updated"],
  [MessageType.PollResult, "poll results posted"],
  [MessageType.PurchaseNotification, "purchase notification"],
]);

export function resolveDiscordSystemEvent(message: Message, location: string): string | null {
  const action = message.type === undefined ? undefined : SYSTEM_EVENT_ACTIONS.get(message.type);
  if (!action) {
    return null;
  }
  const authorLabel = message.author ? formatDiscordUserTag(message.author) : "";
  const actor = authorLabel ? `${authorLabel} ` : "";
  return `Discord system: ${actor}${action} in ${location}`;
}
