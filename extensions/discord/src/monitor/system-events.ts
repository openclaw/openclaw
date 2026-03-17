import { type Message, MessageType } from "@buape/carbon";
import { formatDiscordUserTag } from "./format.js";

export function resolveDiscordSystemEvent(message: Message, location: string): string | null {
  switch (message.type) {
    case MessageType.Call:
      return buildDiscordSystemEvent(message, location, "started a call");
    case MessageType.ChannelNameChange:
      return buildDiscordSystemEvent(message, location, "renamed the channel");
    case MessageType.ChannelIconChange:
      return buildDiscordSystemEvent(message, location, "changed the channel icon");
    case MessageType.ChannelPinnedMessage:
      return buildDiscordSystemEvent(message, location, "pinned a message");
    case MessageType.RecipientAdd:
      return buildDiscordSystemEvent(message, location, "added a recipient");
    case MessageType.RecipientRemove:
      return buildDiscordSystemEvent(message, location, "removed a recipient");
    case MessageType.UserJoin:
      return buildDiscordSystemEvent(message, location, "user joined");
    case MessageType.GuildBoost:
      return buildDiscordSystemEvent(message, location, "boosted the server");
    case MessageType.GuildBoostTier1:
      return buildDiscordSystemEvent(message, location, "boosted the server (Tier 1 reached)");
    case MessageType.GuildBoostTier2:
      return buildDiscordSystemEvent(message, location, "boosted the server (Tier 2 reached)");
    case MessageType.GuildBoostTier3:
      return buildDiscordSystemEvent(message, location, "boosted the server (Tier 3 reached)");
    case MessageType.ChannelFollowAdd:
      return buildDiscordSystemEvent(message, location, "followed announcements");
    case MessageType.GuildDiscoveryDisqualified:
      return buildDiscordSystemEvent(message, location, "lost Server Discovery eligibility");
    case MessageType.GuildDiscoveryRequalified:
      return buildDiscordSystemEvent(message, location, "regained Server Discovery eligibility");
    case MessageType.GuildDiscoveryGracePeriodInitialWarning:
      return buildDiscordSystemEvent(message, location, "received a Server Discovery warning");
    case MessageType.GuildDiscoveryGracePeriodFinalWarning:
      return buildDiscordSystemEvent(
        message,
        location,
        "received a final Server Discovery warning",
      );
    case MessageType.ThreadCreated:
      return buildDiscordSystemEvent(message, location, "created a thread");
    case MessageType.GuildInviteReminder:
      return buildDiscordSystemEvent(message, location, "posted an invite reminder");
    case MessageType.AutoModerationAction:
      return buildDiscordSystemEvent(message, location, "auto moderation action");
    case MessageType.RoleSubscriptionPurchase:
      return buildDiscordSystemEvent(message, location, "purchased a role subscription");
    case MessageType.InteractionPremiumUpsell:
      return buildDiscordSystemEvent(message, location, "posted a premium upsell");
    case MessageType.GuildIncidentAlertModeEnabled:
      return buildDiscordSystemEvent(message, location, "raid protection enabled");
    case MessageType.GuildIncidentAlertModeDisabled:
      return buildDiscordSystemEvent(message, location, "raid protection disabled");
    case MessageType.GuildIncidentReportRaid:
      return buildDiscordSystemEvent(message, location, "raid reported");
    case MessageType.GuildIncidentReportFalseAlarm:
      return buildDiscordSystemEvent(message, location, "raid report marked false alarm");
    case MessageType.StageStart:
      return buildDiscordSystemEvent(message, location, "stage started");
    case MessageType.StageEnd:
      return buildDiscordSystemEvent(message, location, "stage ended");
    case MessageType.StageSpeaker:
      return buildDiscordSystemEvent(message, location, "stage speaker updated");
    case MessageType.StageRaiseHand:
      return buildDiscordSystemEvent(message, location, "raised a hand in the stage");
    case MessageType.StageTopic:
      return buildDiscordSystemEvent(message, location, "stage topic updated");
    case MessageType.GuildApplicationPremiumSubscription:
      return buildDiscordSystemEvent(message, location, "purchased an app subscription");
    case MessageType.PollResult:
      return buildDiscordSystemEvent(message, location, "poll results posted");
    case MessageType.PurchaseNotification:
      return buildDiscordSystemEvent(message, location, "purchase notification");
    default:
      return null;
  }
}

function buildDiscordSystemEvent(message: Message, location: string, action: string) {
  const authorLabel = message.author ? formatDiscordUserTag(message.author) : "";
  const actor = authorLabel ? `${authorLabel} ` : "";
  return `Discord system: ${actor}${action} in ${location}`;
}
