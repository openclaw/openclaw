import { MessageType } from "@buape/carbon";
import { describe, expect, it } from "vitest";
import { resolveDiscordSystemEvent } from "./system-events.js";

function createMessage(type: MessageType) {
  return {
    type,
    author: {
      id: "user-1",
      username: "alice",
      discriminator: "1234",
      bot: false,
    },
  } as import("@buape/carbon").Message;
}

describe("resolveDiscordSystemEvent", () => {
  it("maps audited Discord system message types", () => {
    const location = "Guild One #general";
    const cases = [
      [MessageType.Call, "started a call"],
      [MessageType.RecipientAdd, "added a recipient"],
      [MessageType.RecipientRemove, "removed a recipient"],
      [MessageType.ChannelNameChange, "renamed the channel"],
      [MessageType.ChannelIconChange, "changed the channel icon"],
      [MessageType.ChannelPinnedMessage, "pinned a message"],
      [MessageType.UserJoin, "user joined"],
      [MessageType.GuildBoost, "boosted the server"],
      [MessageType.GuildBoostTier1, "boosted the server (Tier 1 reached)"],
      [MessageType.GuildBoostTier2, "boosted the server (Tier 2 reached)"],
      [MessageType.GuildBoostTier3, "boosted the server (Tier 3 reached)"],
      [MessageType.ChannelFollowAdd, "followed announcements"],
      [MessageType.GuildDiscoveryDisqualified, "lost Server Discovery eligibility"],
      [MessageType.GuildDiscoveryRequalified, "regained Server Discovery eligibility"],
      [MessageType.GuildDiscoveryGracePeriodInitialWarning, "received a Server Discovery warning"],
      [
        MessageType.GuildDiscoveryGracePeriodFinalWarning,
        "received a final Server Discovery warning",
      ],
      [MessageType.ThreadCreated, "created a thread"],
      [MessageType.GuildInviteReminder, "posted an invite reminder"],
      [MessageType.AutoModerationAction, "auto moderation action"],
      [MessageType.RoleSubscriptionPurchase, "purchased a role subscription"],
      [MessageType.InteractionPremiumUpsell, "posted a premium upsell"],
      [MessageType.StageStart, "stage started"],
      [MessageType.StageEnd, "stage ended"],
      [MessageType.StageSpeaker, "stage speaker updated"],
      [MessageType.StageRaiseHand, "raised a hand in the stage"],
      [MessageType.StageTopic, "stage topic updated"],
      [MessageType.GuildApplicationPremiumSubscription, "purchased an app subscription"],
      [MessageType.GuildIncidentAlertModeEnabled, "raid protection enabled"],
      [MessageType.GuildIncidentAlertModeDisabled, "raid protection disabled"],
      [MessageType.GuildIncidentReportRaid, "raid reported"],
      [MessageType.GuildIncidentReportFalseAlarm, "raid report marked false alarm"],
      [MessageType.PurchaseNotification, "purchase notification"],
      [MessageType.PollResult, "poll results posted"],
    ] as const;

    for (const [type, action] of cases) {
      expect(resolveDiscordSystemEvent(createMessage(type), location)).toBe(
        `Discord system: alice#1234 ${action} in ${location}`,
      );
    }
  });

  it("leaves user-authored or content-carrying message types alone", () => {
    const location = "Guild One #general";
    const cases = [
      MessageType.Default,
      MessageType.Reply,
      MessageType.ChatInputCommand,
      MessageType.ThreadStarterMessage,
      MessageType.ContextMenuCommand,
    ];

    for (const type of cases) {
      expect(resolveDiscordSystemEvent(createMessage(type), location)).toBeNull();
    }
  });
});
