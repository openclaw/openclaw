import { a as readDiscordChannelCreateParams, n as isDiscordModerationAction, o as readDiscordChannelEditParams, r as readDiscordModerationCommand, s as readDiscordChannelMoveParams, t as handleDiscordAction } from "./runtime-SoSwefbS.js";
import "./action-runtime-api.js";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { readNumberParam, readStringArrayParam, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
//#region extensions/discord/src/actions/handle-action.guild-admin.ts
async function tryHandleDiscordMessageActionGuildAdmin(params) {
	const { ctx, resolveChannelId } = params;
	const { action, params: actionParams, cfg } = ctx;
	const accountId = ctx.accountId ?? readStringParam(actionParams, "accountId");
	if (action === "member-info") {
		const userId = readStringParam(actionParams, "userId", { required: true });
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		return await handleDiscordAction({
			action: "memberInfo",
			accountId: accountId ?? void 0,
			guildId,
			userId
		}, cfg);
	}
	if (action === "role-info") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		return await handleDiscordAction({
			action: "roleInfo",
			accountId: accountId ?? void 0,
			guildId
		}, cfg);
	}
	if (action === "emoji-list") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		return await handleDiscordAction({
			action: "emojiList",
			accountId: accountId ?? void 0,
			guildId
		}, cfg);
	}
	if (action === "emoji-upload") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const name = readStringParam(actionParams, "emojiName", { required: true });
		const mediaUrl = readStringParam(actionParams, "media", {
			required: true,
			trim: false
		});
		const roleIds = readStringArrayParam(actionParams, "roleIds");
		return await handleDiscordAction({
			action: "emojiUpload",
			accountId: accountId ?? void 0,
			guildId,
			name,
			mediaUrl,
			roleIds
		}, cfg);
	}
	if (action === "sticker-upload") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const name = readStringParam(actionParams, "stickerName", { required: true });
		const description = readStringParam(actionParams, "stickerDesc", { required: true });
		const tags = readStringParam(actionParams, "stickerTags", { required: true });
		const mediaUrl = readStringParam(actionParams, "media", {
			required: true,
			trim: false
		});
		return await handleDiscordAction({
			action: "stickerUpload",
			accountId: accountId ?? void 0,
			guildId,
			name,
			description,
			tags,
			mediaUrl
		}, cfg);
	}
	if (action === "role-add" || action === "role-remove") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const userId = readStringParam(actionParams, "userId", { required: true });
		const roleId = readStringParam(actionParams, "roleId", { required: true });
		return await handleDiscordAction({
			action: action === "role-add" ? "roleAdd" : "roleRemove",
			accountId: accountId ?? void 0,
			guildId,
			userId,
			roleId
		}, cfg);
	}
	if (action === "channel-info") {
		const channelId = readStringParam(actionParams, "channelId", { required: true });
		return await handleDiscordAction({
			action: "channelInfo",
			accountId: accountId ?? void 0,
			channelId
		}, cfg);
	}
	if (action === "channel-list") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		return await handleDiscordAction({
			action: "channelList",
			accountId: accountId ?? void 0,
			guildId
		}, cfg);
	}
	if (action === "channel-create") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		return await handleDiscordAction({
			action: "channelCreate",
			accountId: accountId ?? void 0,
			...readDiscordChannelCreateParams({
				...actionParams,
				guildId
			})
		}, cfg);
	}
	if (action === "channel-edit") {
		const channelId = readStringParam(actionParams, "channelId", { required: true });
		return await handleDiscordAction({
			action: "channelEdit",
			accountId: accountId ?? void 0,
			...readDiscordChannelEditParams({
				...actionParams,
				channelId
			})
		}, cfg);
	}
	if (action === "channel-delete") {
		const channelId = readStringParam(actionParams, "channelId", { required: true });
		return await handleDiscordAction({
			action: "channelDelete",
			accountId: accountId ?? void 0,
			channelId
		}, cfg);
	}
	if (action === "channel-move") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const channelId = readStringParam(actionParams, "channelId", { required: true });
		return await handleDiscordAction({
			action: "channelMove",
			accountId: accountId ?? void 0,
			...readDiscordChannelMoveParams({
				...actionParams,
				guildId,
				channelId
			})
		}, cfg);
	}
	if (action === "category-create") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const name = readStringParam(actionParams, "name", { required: true });
		const position = readNumberParam(actionParams, "position", { integer: true });
		return await handleDiscordAction({
			action: "categoryCreate",
			accountId: accountId ?? void 0,
			guildId,
			name,
			position: position ?? void 0
		}, cfg);
	}
	if (action === "category-edit") {
		const categoryId = readStringParam(actionParams, "categoryId", { required: true });
		const name = readStringParam(actionParams, "name");
		const position = readNumberParam(actionParams, "position", { integer: true });
		return await handleDiscordAction({
			action: "categoryEdit",
			accountId: accountId ?? void 0,
			categoryId,
			name: name ?? void 0,
			position: position ?? void 0
		}, cfg);
	}
	if (action === "category-delete") {
		const categoryId = readStringParam(actionParams, "categoryId", { required: true });
		return await handleDiscordAction({
			action: "categoryDelete",
			accountId: accountId ?? void 0,
			categoryId
		}, cfg);
	}
	if (action === "voice-status") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const userId = readStringParam(actionParams, "userId", { required: true });
		return await handleDiscordAction({
			action: "voiceStatus",
			accountId: accountId ?? void 0,
			guildId,
			userId
		}, cfg);
	}
	if (action === "event-list") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		return await handleDiscordAction({
			action: "eventList",
			accountId: accountId ?? void 0,
			guildId
		}, cfg);
	}
	if (action === "event-create") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const name = readStringParam(actionParams, "eventName", { required: true });
		const startTime = readStringParam(actionParams, "startTime", { required: true });
		const endTime = readStringParam(actionParams, "endTime");
		const description = readStringParam(actionParams, "desc");
		const channelId = readStringParam(actionParams, "channelId");
		const location = readStringParam(actionParams, "location");
		const entityType = readStringParam(actionParams, "eventType");
		const image = readStringParam(actionParams, "image", { trim: false });
		return await handleDiscordAction({
			action: "eventCreate",
			accountId: accountId ?? void 0,
			guildId,
			name,
			startTime,
			endTime,
			description,
			channelId,
			location,
			entityType,
			image
		}, cfg, { mediaLocalRoots: ctx.mediaLocalRoots });
	}
	if (isDiscordModerationAction(action)) {
		const moderation = readDiscordModerationCommand(action, {
			...actionParams,
			durationMinutes: readNumberParam(actionParams, "durationMin", { integer: true }),
			deleteMessageDays: readNumberParam(actionParams, "deleteDays", { integer: true })
		});
		const senderUserId = normalizeOptionalString(ctx.requesterSenderId);
		return await handleDiscordAction({
			action: moderation.action,
			accountId: accountId ?? void 0,
			guildId: moderation.guildId,
			userId: moderation.userId,
			durationMinutes: moderation.durationMinutes,
			until: moderation.until,
			reason: moderation.reason,
			deleteMessageDays: moderation.deleteMessageDays,
			senderUserId
		}, cfg);
	}
	if (action === "thread-list") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const channelId = readStringParam(actionParams, "channelId");
		const includeArchived = typeof actionParams.includeArchived === "boolean" ? actionParams.includeArchived : void 0;
		const before = readStringParam(actionParams, "before");
		const limit = readNumberParam(actionParams, "limit", { integer: true });
		return await handleDiscordAction({
			action: "threadList",
			accountId: accountId ?? void 0,
			guildId,
			channelId,
			includeArchived,
			before,
			limit
		}, cfg);
	}
	if (action === "thread-reply") {
		const content = readStringParam(actionParams, "message", { required: true });
		const mediaUrl = readStringParam(actionParams, "media", { trim: false });
		const replyTo = readStringParam(actionParams, "replyTo");
		const channelId = readStringParam(actionParams, "threadId") ?? resolveChannelId();
		return await handleDiscordAction({
			action: "threadReply",
			accountId: accountId ?? void 0,
			channelId,
			content,
			mediaUrl: mediaUrl ?? void 0,
			replyTo: replyTo ?? void 0
		}, cfg);
	}
	if (action === "search") {
		const guildId = readStringParam(actionParams, "guildId", { required: true });
		const query = readStringParam(actionParams, "query", { required: true });
		return await handleDiscordAction({
			action: "searchMessages",
			accountId: accountId ?? void 0,
			guildId,
			content: query,
			channelId: readStringParam(actionParams, "channelId"),
			channelIds: readStringArrayParam(actionParams, "channelIds"),
			authorId: readStringParam(actionParams, "authorId"),
			authorIds: readStringArrayParam(actionParams, "authorIds"),
			limit: readNumberParam(actionParams, "limit", { integer: true })
		}, cfg);
	}
}
//#endregion
export { tryHandleDiscordMessageActionGuildAdmin as t };
