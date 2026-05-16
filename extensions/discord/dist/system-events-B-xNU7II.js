import { t as discord_exports } from "./discord-eZlimVfW.js";
import { n as formatDiscordUserTag } from "./format-D8TsaXxW.js";
//#region extensions/discord/src/monitor/system-events.ts
function resolveDiscordSystemEvent(message, location) {
	switch (message.type) {
		case discord_exports.MessageType.ChannelPinnedMessage: return buildDiscordSystemEvent(message, location, "pinned a message");
		case discord_exports.MessageType.RecipientAdd: return buildDiscordSystemEvent(message, location, "added a recipient");
		case discord_exports.MessageType.RecipientRemove: return buildDiscordSystemEvent(message, location, "removed a recipient");
		case discord_exports.MessageType.UserJoin: return buildDiscordSystemEvent(message, location, "user joined");
		case discord_exports.MessageType.GuildBoost: return buildDiscordSystemEvent(message, location, "boosted the server");
		case discord_exports.MessageType.GuildBoostTier1: return buildDiscordSystemEvent(message, location, "boosted the server (Tier 1 reached)");
		case discord_exports.MessageType.GuildBoostTier2: return buildDiscordSystemEvent(message, location, "boosted the server (Tier 2 reached)");
		case discord_exports.MessageType.GuildBoostTier3: return buildDiscordSystemEvent(message, location, "boosted the server (Tier 3 reached)");
		case discord_exports.MessageType.ThreadCreated: return buildDiscordSystemEvent(message, location, "created a thread");
		case discord_exports.MessageType.AutoModerationAction: return buildDiscordSystemEvent(message, location, "auto moderation action");
		case discord_exports.MessageType.GuildIncidentAlertModeEnabled: return buildDiscordSystemEvent(message, location, "raid protection enabled");
		case discord_exports.MessageType.GuildIncidentAlertModeDisabled: return buildDiscordSystemEvent(message, location, "raid protection disabled");
		case discord_exports.MessageType.GuildIncidentReportRaid: return buildDiscordSystemEvent(message, location, "raid reported");
		case discord_exports.MessageType.GuildIncidentReportFalseAlarm: return buildDiscordSystemEvent(message, location, "raid report marked false alarm");
		case discord_exports.MessageType.StageStart: return buildDiscordSystemEvent(message, location, "stage started");
		case discord_exports.MessageType.StageEnd: return buildDiscordSystemEvent(message, location, "stage ended");
		case discord_exports.MessageType.StageSpeaker: return buildDiscordSystemEvent(message, location, "stage speaker updated");
		case discord_exports.MessageType.StageTopic: return buildDiscordSystemEvent(message, location, "stage topic updated");
		case discord_exports.MessageType.PollResult: return buildDiscordSystemEvent(message, location, "poll results posted");
		case discord_exports.MessageType.PurchaseNotification: return buildDiscordSystemEvent(message, location, "purchase notification");
		default: return null;
	}
}
function buildDiscordSystemEvent(message, location, action) {
	const authorLabel = message.author ? formatDiscordUserTag(message.author) : "";
	return `Discord system: ${authorLabel ? `${authorLabel} ` : ""}${action} in ${location}`;
}
//#endregion
export { resolveDiscordSystemEvent };
