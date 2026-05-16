import { o as resolveDefaultDiscordAccountId, t as createDiscordActionGate } from "./accounts-CaHGiVB4.js";
import { s as resolveDiscordChannelId } from "./normalize-B-ktw-T_.js";
import { c as jsonResult, d as readNumberParam, f as readReactionParams, g as withNormalizedTimestamp, h as resolvePollMaxSelections, l as parseAvailableTags, m as readStringParam, p as readStringArrayParam, r as sendDiscordComponentMessage, s as assertMediaNotDataUrl, u as readBooleanParam } from "./send.components-CJ8gYK3s.js";
import { n as getGateway, o as getPresence } from "./gateway-registry-BKG4KIVC.js";
import { O as hasAnyGuildPermissionDiscord, P as createDiscordRuntimeAccountContext, T as fetchChannelPermissionsDiscord, d as resolveDiscordTargetChannelId } from "./send.shared-e9Pd_Em0.js";
import { A as removeRoleDiscord, B as removeChannelPermissionDiscord, C as fetchChannelInfoDiscord, D as kickMemberDiscord, E as fetchVoiceStatusDiscord, F as uploadStickerDiscord, I as createChannelDiscord, L as deleteChannelDiscord, M as timeoutMemberDiscord, N as listGuildEmojisDiscord, O as listGuildChannelsDiscord, P as uploadEmojiDiscord, R as editChannelDiscord, S as createScheduledEventDiscord, T as fetchRoleInfoDiscord, V as setChannelPermissionDiscord, _ as readMessagesDiscord, a as removeReactionDiscord, b as addRoleDiscord, d as deleteMessageDiscord, f as editMessageDiscord, g as pinMessageDiscord, h as listThreadsDiscord, i as removeOwnReactionsDiscord, j as resolveEventCoverImage, k as listScheduledEventsDiscord, l as DiscordThreadInitialMessageError, m as listPinsDiscord, n as fetchReactionsDiscord, p as fetchMessageDiscord, r as reactMessageDiscord, s as sendVoiceMessageDiscord, u as createThreadDiscord, v as searchMessagesDiscord, w as fetchMemberInfoDiscord, x as banMemberDiscord, y as unpinMessageDiscord, z as moveChannelDiscord } from "./send-Dw6Da1m2.js";
import { n as sendPollDiscord, r as sendStickerDiscord, t as sendMessageDiscord } from "./send.outbound-6KbINW5h.js";
import { c as readDiscordComponentSpec } from "./components-D5LnN7ZQ.js";
import "./targets-B7OfGFt8.js";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { PermissionFlagsBits } from "discord-api-types/v10";
//#region extensions/discord/src/actions/runtime.shared.ts
function readDiscordParentIdParam(params) {
	if (params.clearParent === true) return null;
	if (params.parentId === null) return null;
	return readStringParam(params, "parentId");
}
function readDiscordBooleanParam(params, key) {
	return typeof params[key] === "boolean" ? params[key] : void 0;
}
function createDiscordActionOptions(params) {
	return {
		cfg: params.cfg,
		...params.accountId ? { accountId: params.accountId } : {},
		...params.extra ?? {}
	};
}
function readDiscordChannelCreateParams(params) {
	const parentId = readDiscordParentIdParam(params);
	return {
		guildId: readStringParam(params, "guildId", { required: true }),
		name: readStringParam(params, "name", { required: true }),
		type: readNumberParam(params, "type", { integer: true }) ?? void 0,
		parentId: parentId ?? void 0,
		topic: readStringParam(params, "topic") ?? void 0,
		position: readNumberParam(params, "position", { integer: true }) ?? void 0,
		nsfw: readDiscordBooleanParam(params, "nsfw")
	};
}
function readDiscordChannelEditParams(params) {
	const parentId = readDiscordParentIdParam(params);
	return {
		channelId: readStringParam(params, "channelId", { required: true }),
		name: readStringParam(params, "name") ?? void 0,
		topic: readStringParam(params, "topic") ?? void 0,
		position: readNumberParam(params, "position", { integer: true }) ?? void 0,
		parentId: parentId === void 0 ? void 0 : parentId,
		nsfw: readDiscordBooleanParam(params, "nsfw"),
		rateLimitPerUser: readNumberParam(params, "rateLimitPerUser", { integer: true }) ?? void 0,
		archived: readDiscordBooleanParam(params, "archived"),
		locked: readDiscordBooleanParam(params, "locked"),
		autoArchiveDuration: readNumberParam(params, "autoArchiveDuration", { integer: true }) ?? void 0,
		availableTags: parseAvailableTags(params.availableTags)
	};
}
function readDiscordChannelMoveParams(params) {
	const parentId = readDiscordParentIdParam(params);
	return {
		guildId: readStringParam(params, "guildId", { required: true }),
		channelId: readStringParam(params, "channelId", { required: true }),
		parentId: parentId === void 0 ? void 0 : parentId,
		position: readNumberParam(params, "position", { integer: true }) ?? void 0
	};
}
//#endregion
//#region extensions/discord/src/actions/runtime.guild.ts
const discordGuildActionRuntime = {
	addRoleDiscord,
	createChannelDiscord,
	createScheduledEventDiscord,
	resolveEventCoverImage,
	deleteChannelDiscord,
	editChannelDiscord,
	fetchChannelInfoDiscord,
	fetchMemberInfoDiscord,
	fetchRoleInfoDiscord,
	fetchVoiceStatusDiscord,
	listGuildChannelsDiscord,
	listGuildEmojisDiscord,
	listScheduledEventsDiscord,
	moveChannelDiscord,
	removeChannelPermissionDiscord,
	removeRoleDiscord,
	setChannelPermissionDiscord,
	uploadEmojiDiscord,
	uploadStickerDiscord
};
async function runRoleMutation(params) {
	const guildId = readStringParam(params.values, "guildId", { required: true });
	const userId = readStringParam(params.values, "userId", { required: true });
	const roleId = readStringParam(params.values, "roleId", { required: true });
	await params.mutate({
		guildId,
		userId,
		roleId
	}, createDiscordActionOptions({
		cfg: params.cfg,
		accountId: params.accountId
	}));
}
function readChannelPermissionTarget(params) {
	return {
		channelId: readStringParam(params, "channelId", { required: true }),
		targetId: readStringParam(params, "targetId", { required: true })
	};
}
async function handleDiscordGuildAction(action, params, isActionEnabled, cfg, options) {
	const accountId = readStringParam(params, "accountId");
	if (!cfg) throw new Error("Discord guild actions require a resolved runtime config.");
	const withOpts = (extra) => createDiscordActionOptions({
		cfg,
		accountId,
		extra
	});
	switch (action) {
		case "memberInfo": {
			if (!isActionEnabled("memberInfo")) throw new Error("Discord member info is disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			const userId = readStringParam(params, "userId", { required: true });
			const effectiveAccountId = accountId ?? resolveDefaultDiscordAccountId(cfg);
			const member = await discordGuildActionRuntime.fetchMemberInfoDiscord(guildId, userId, createDiscordActionOptions({
				cfg,
				accountId: effectiveAccountId
			}));
			const presence = getPresence(effectiveAccountId, userId);
			const activities = presence?.activities ?? void 0;
			const status = presence?.status ?? void 0;
			return jsonResult({
				ok: true,
				member,
				...presence ? {
					status,
					activities
				} : {}
			});
		}
		case "roleInfo": {
			if (!isActionEnabled("roleInfo")) throw new Error("Discord role info is disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			return jsonResult({
				ok: true,
				roles: await discordGuildActionRuntime.fetchRoleInfoDiscord(guildId, withOpts())
			});
		}
		case "emojiList": {
			if (!isActionEnabled("reactions")) throw new Error("Discord reactions are disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			return jsonResult({
				ok: true,
				emojis: await discordGuildActionRuntime.listGuildEmojisDiscord(guildId, withOpts())
			});
		}
		case "emojiUpload": {
			if (!isActionEnabled("emojiUploads")) throw new Error("Discord emoji uploads are disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			const name = readStringParam(params, "name", { required: true });
			const mediaUrl = readStringParam(params, "mediaUrl", { required: true });
			const roleIds = readStringArrayParam(params, "roleIds");
			return jsonResult({
				ok: true,
				emoji: await discordGuildActionRuntime.uploadEmojiDiscord({
					guildId,
					name,
					mediaUrl,
					roleIds: roleIds?.length ? roleIds : void 0
				}, withOpts())
			});
		}
		case "stickerUpload": {
			if (!isActionEnabled("stickerUploads")) throw new Error("Discord sticker uploads are disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			const name = readStringParam(params, "name", { required: true });
			const description = readStringParam(params, "description", { required: true });
			const tags = readStringParam(params, "tags", { required: true });
			const mediaUrl = readStringParam(params, "mediaUrl", { required: true });
			return jsonResult({
				ok: true,
				sticker: await discordGuildActionRuntime.uploadStickerDiscord({
					guildId,
					name,
					description,
					tags,
					mediaUrl
				}, withOpts())
			});
		}
		case "roleAdd":
			if (!isActionEnabled("roles", false)) throw new Error("Discord role changes are disabled.");
			await runRoleMutation({
				cfg,
				accountId,
				values: params,
				mutate: discordGuildActionRuntime.addRoleDiscord
			});
			return jsonResult({ ok: true });
		case "roleRemove":
			if (!isActionEnabled("roles", false)) throw new Error("Discord role changes are disabled.");
			await runRoleMutation({
				cfg,
				accountId,
				values: params,
				mutate: discordGuildActionRuntime.removeRoleDiscord
			});
			return jsonResult({ ok: true });
		case "channelInfo": {
			if (!isActionEnabled("channelInfo")) throw new Error("Discord channel info is disabled.");
			const channelId = readStringParam(params, "channelId", { required: true });
			return jsonResult({
				ok: true,
				channel: await discordGuildActionRuntime.fetchChannelInfoDiscord(channelId, withOpts())
			});
		}
		case "channelList": {
			if (!isActionEnabled("channelInfo")) throw new Error("Discord channel info is disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			return jsonResult({
				ok: true,
				channels: await discordGuildActionRuntime.listGuildChannelsDiscord(guildId, withOpts())
			});
		}
		case "voiceStatus": {
			if (!isActionEnabled("voiceStatus")) throw new Error("Discord voice status is disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			const userId = readStringParam(params, "userId", { required: true });
			return jsonResult({
				ok: true,
				voice: await discordGuildActionRuntime.fetchVoiceStatusDiscord(guildId, userId, withOpts())
			});
		}
		case "eventList": {
			if (!isActionEnabled("events")) throw new Error("Discord events are disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			return jsonResult({
				ok: true,
				events: await discordGuildActionRuntime.listScheduledEventsDiscord(guildId, withOpts())
			});
		}
		case "eventCreate": {
			if (!isActionEnabled("events")) throw new Error("Discord events are disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			const name = readStringParam(params, "name", { required: true });
			const startTime = readStringParam(params, "startTime", { required: true });
			const endTime = readStringParam(params, "endTime");
			const description = readStringParam(params, "description");
			const channelId = readStringParam(params, "channelId");
			const location = readStringParam(params, "location");
			const imageUrl = readStringParam(params, "image", { trim: false });
			const entityTypeRaw = readStringParam(params, "entityType");
			const entityType = entityTypeRaw === "stage" ? 1 : entityTypeRaw === "external" ? 3 : 2;
			const image = imageUrl ? await discordGuildActionRuntime.resolveEventCoverImage(imageUrl, { localRoots: options?.mediaLocalRoots }) : void 0;
			const payload = {
				name,
				description,
				scheduled_start_time: startTime,
				scheduled_end_time: endTime,
				entity_type: entityType,
				channel_id: channelId,
				entity_metadata: entityType === 3 && location ? { location } : void 0,
				image,
				privacy_level: 2
			};
			return jsonResult({
				ok: true,
				event: await discordGuildActionRuntime.createScheduledEventDiscord(guildId, payload, withOpts())
			});
		}
		case "channelCreate":
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			return jsonResult({
				ok: true,
				channel: await discordGuildActionRuntime.createChannelDiscord(readDiscordChannelCreateParams(params), withOpts())
			});
		case "channelEdit":
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			return jsonResult({
				ok: true,
				channel: await discordGuildActionRuntime.editChannelDiscord(readDiscordChannelEditParams(params), withOpts())
			});
		case "channelDelete": {
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			const channelId = readStringParam(params, "channelId", { required: true });
			return jsonResult(await discordGuildActionRuntime.deleteChannelDiscord(channelId, withOpts()));
		}
		case "channelMove":
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			await discordGuildActionRuntime.moveChannelDiscord(readDiscordChannelMoveParams(params), withOpts());
			return jsonResult({ ok: true });
		case "categoryCreate": {
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			const guildId = readStringParam(params, "guildId", { required: true });
			const name = readStringParam(params, "name", { required: true });
			const position = readNumberParam(params, "position", { integer: true });
			return jsonResult({
				ok: true,
				category: await discordGuildActionRuntime.createChannelDiscord({
					guildId,
					name,
					type: 4,
					position: position ?? void 0
				}, withOpts())
			});
		}
		case "categoryEdit": {
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			const categoryId = readStringParam(params, "categoryId", { required: true });
			const name = readStringParam(params, "name");
			const position = readNumberParam(params, "position", { integer: true });
			return jsonResult({
				ok: true,
				category: await discordGuildActionRuntime.editChannelDiscord({
					channelId: categoryId,
					name: name ?? void 0,
					position: position ?? void 0
				}, withOpts())
			});
		}
		case "categoryDelete": {
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			const categoryId = readStringParam(params, "categoryId", { required: true });
			return jsonResult(await discordGuildActionRuntime.deleteChannelDiscord(categoryId, withOpts()));
		}
		case "channelPermissionSet": {
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			const { channelId, targetId } = readChannelPermissionTarget(params);
			const targetType = readStringParam(params, "targetType", { required: true }) === "member" ? 1 : 0;
			const allow = readStringParam(params, "allow");
			const deny = readStringParam(params, "deny");
			await discordGuildActionRuntime.setChannelPermissionDiscord({
				channelId,
				targetId,
				targetType,
				allow: allow ?? void 0,
				deny: deny ?? void 0
			}, withOpts());
			return jsonResult({ ok: true });
		}
		case "channelPermissionRemove": {
			if (!isActionEnabled("channels")) throw new Error("Discord channel management is disabled.");
			const { channelId, targetId } = readChannelPermissionTarget(params);
			await discordGuildActionRuntime.removeChannelPermissionDiscord(channelId, targetId, withOpts());
			return jsonResult({ ok: true });
		}
		default: throw new Error(`Unknown action: ${action}`);
	}
}
//#endregion
//#region extensions/discord/src/actions/runtime.messaging.runtime.ts
const discordMessagingActionRuntime = {
	createThreadDiscord,
	deleteMessageDiscord,
	editMessageDiscord,
	fetchChannelPermissionsDiscord,
	fetchMessageDiscord,
	fetchReactionsDiscord,
	listPinsDiscord,
	listThreadsDiscord,
	pinMessageDiscord,
	reactMessageDiscord,
	readDiscordComponentSpec,
	readMessagesDiscord,
	removeOwnReactionsDiscord,
	removeReactionDiscord,
	resolveDiscordReactionTargetChannelId,
	resolveDiscordChannelId,
	searchMessagesDiscord,
	sendDiscordComponentMessage,
	sendMessageDiscord,
	sendPollDiscord,
	sendStickerDiscord,
	sendVoiceMessageDiscord,
	unpinMessageDiscord
};
async function resolveDiscordReactionTargetChannelId(params) {
	try {
		return resolveDiscordChannelId(params.target);
	} catch {
		return (await resolveDiscordTargetChannelId(params.target, {
			cfg: params.cfg,
			accountId: params.accountId
		})).channelId;
	}
}
//#endregion
//#region extensions/discord/src/actions/runtime.messaging.messages.ts
function parseDiscordMessageLink(link) {
	const match = link.trim().match(/^(?:https?:\/\/)?(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)(?:\/?|\?.*)$/i);
	if (!match) throw new Error("Invalid Discord message link. Expected https://discord.com/channels/<guildId>/<channelId>/<messageId>.");
	return {
		guildId: match[1],
		channelId: match[2],
		messageId: match[3]
	};
}
async function handleDiscordMessageManagementAction(ctx) {
	switch (ctx.action) {
		case "permissions": {
			if (!ctx.isActionEnabled("permissions")) throw new Error("Discord permissions are disabled.");
			const channelId = ctx.resolveChannelId();
			return jsonResult({
				ok: true,
				permissions: await discordMessagingActionRuntime.fetchChannelPermissionsDiscord(channelId, ctx.withOpts())
			});
		}
		case "fetchMessage": {
			if (!ctx.isActionEnabled("messages")) throw new Error("Discord message reads are disabled.");
			const messageLink = readStringParam(ctx.params, "messageLink");
			let guildId = readStringParam(ctx.params, "guildId");
			let channelId = readStringParam(ctx.params, "channelId");
			let messageId = readStringParam(ctx.params, "messageId");
			if (messageLink) {
				const parsed = parseDiscordMessageLink(messageLink);
				guildId = parsed.guildId;
				channelId = parsed.channelId;
				messageId = parsed.messageId;
			}
			if (!guildId || !channelId || !messageId) throw new Error("Discord message fetch requires guildId, channelId, and messageId (or a valid messageLink).");
			const message = await discordMessagingActionRuntime.fetchMessageDiscord(channelId, messageId, ctx.withOpts());
			return jsonResult({
				ok: true,
				message: ctx.normalizeMessage(message),
				guildId,
				channelId,
				messageId
			});
		}
		case "readMessages": {
			if (!ctx.isActionEnabled("messages")) throw new Error("Discord message reads are disabled.");
			const channelId = ctx.resolveChannelId();
			const query = {
				limit: readNumberParam(ctx.params, "limit"),
				before: readStringParam(ctx.params, "before"),
				after: readStringParam(ctx.params, "after"),
				around: readStringParam(ctx.params, "around")
			};
			return jsonResult({
				ok: true,
				messages: (await discordMessagingActionRuntime.readMessagesDiscord(channelId, query, ctx.withOpts())).map((message) => ctx.normalizeMessage(message))
			});
		}
		case "editMessage": {
			if (!ctx.isActionEnabled("messages")) throw new Error("Discord message edits are disabled.");
			const channelId = ctx.resolveChannelId();
			const messageId = readStringParam(ctx.params, "messageId", { required: true });
			const content = readStringParam(ctx.params, "content", { required: true });
			return jsonResult({
				ok: true,
				message: await discordMessagingActionRuntime.editMessageDiscord(channelId, messageId, { content }, ctx.withOpts())
			});
		}
		case "deleteMessage": {
			if (!ctx.isActionEnabled("messages")) throw new Error("Discord message deletes are disabled.");
			const channelId = ctx.resolveChannelId();
			const messageId = readStringParam(ctx.params, "messageId", { required: true });
			await discordMessagingActionRuntime.deleteMessageDiscord(channelId, messageId, ctx.withOpts());
			return jsonResult({ ok: true });
		}
		case "pinMessage": {
			if (!ctx.isActionEnabled("pins")) throw new Error("Discord pins are disabled.");
			const channelId = ctx.resolveChannelId();
			const messageId = readStringParam(ctx.params, "messageId", { required: true });
			await discordMessagingActionRuntime.pinMessageDiscord(channelId, messageId, ctx.withOpts());
			return jsonResult({ ok: true });
		}
		case "unpinMessage": {
			if (!ctx.isActionEnabled("pins")) throw new Error("Discord pins are disabled.");
			const channelId = ctx.resolveChannelId();
			const messageId = readStringParam(ctx.params, "messageId", { required: true });
			await discordMessagingActionRuntime.unpinMessageDiscord(channelId, messageId, ctx.withOpts());
			return jsonResult({ ok: true });
		}
		case "listPins": {
			if (!ctx.isActionEnabled("pins")) throw new Error("Discord pins are disabled.");
			const channelId = ctx.resolveChannelId();
			return jsonResult({
				ok: true,
				pins: (await discordMessagingActionRuntime.listPinsDiscord(channelId, ctx.withOpts())).map((pin) => ctx.normalizeMessage(pin))
			});
		}
		case "searchMessages": {
			if (!ctx.isActionEnabled("search")) throw new Error("Discord search is disabled.");
			const guildId = readStringParam(ctx.params, "guildId", { required: true });
			const content = readStringParam(ctx.params, "content", { required: true });
			const channelId = readStringParam(ctx.params, "channelId");
			const channelIds = readStringArrayParam(ctx.params, "channelIds");
			const authorId = readStringParam(ctx.params, "authorId");
			const authorIds = readStringArrayParam(ctx.params, "authorIds");
			const limit = readNumberParam(ctx.params, "limit");
			const channelIdList = [...channelIds ?? [], ...channelId ? [channelId] : []];
			const authorIdList = [...authorIds ?? [], ...authorId ? [authorId] : []];
			const results = await discordMessagingActionRuntime.searchMessagesDiscord({
				guildId,
				content,
				channelIds: channelIdList.length ? channelIdList : void 0,
				authorIds: authorIdList.length ? authorIdList : void 0,
				limit
			}, ctx.withOpts());
			if (!results || typeof results !== "object") return jsonResult({
				ok: true,
				results
			});
			const resultsRecord = results;
			const messages = resultsRecord.messages;
			const normalizedMessages = Array.isArray(messages) ? messages.map((group) => Array.isArray(group) ? group.map((msg) => ctx.normalizeMessage(msg)) : group) : messages;
			return jsonResult({
				ok: true,
				results: {
					...resultsRecord,
					messages: normalizedMessages
				}
			});
		}
		default: return;
	}
}
//#endregion
//#region extensions/discord/src/actions/runtime.messaging.reactions.ts
async function handleDiscordReactionMessagingAction(ctx) {
	switch (ctx.action) {
		case "react": {
			if (!ctx.isActionEnabled("reactions")) throw new Error("Discord reactions are disabled.");
			const channelId = await ctx.resolveReactionChannelId();
			const messageId = readStringParam(ctx.params, "messageId", { required: true });
			const { emoji, remove, isEmpty } = readReactionParams(ctx.params, { removeErrorMessage: "Emoji is required to remove a Discord reaction." });
			if (remove) {
				await discordMessagingActionRuntime.removeReactionDiscord(channelId, messageId, emoji, ctx.withReactionRuntimeOptions());
				return jsonResult({
					ok: true,
					removed: emoji
				});
			}
			if (isEmpty) return jsonResult({
				ok: true,
				removed: (await discordMessagingActionRuntime.removeOwnReactionsDiscord(channelId, messageId, ctx.withReactionRuntimeOptions())).removed
			});
			await discordMessagingActionRuntime.reactMessageDiscord(channelId, messageId, emoji, ctx.withReactionRuntimeOptions());
			return jsonResult({
				ok: true,
				added: emoji
			});
		}
		case "reactions": {
			if (!ctx.isActionEnabled("reactions")) throw new Error("Discord reactions are disabled.");
			const channelId = await ctx.resolveReactionChannelId();
			const messageId = readStringParam(ctx.params, "messageId", { required: true });
			const limit = readNumberParam(ctx.params, "limit");
			return jsonResult({
				ok: true,
				reactions: await discordMessagingActionRuntime.fetchReactionsDiscord(channelId, messageId, ctx.withReactionRuntimeOptions({ limit }))
			});
		}
		default: return;
	}
}
//#endregion
//#region extensions/discord/src/actions/runtime.messaging.send.ts
function hasDiscordComponentObjectKeys(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0);
}
async function handleDiscordMessageSendAction(ctx) {
	switch (ctx.action) {
		case "sticker": {
			if (!ctx.isActionEnabled("stickers")) throw new Error("Discord stickers are disabled.");
			const to = readStringParam(ctx.params, "to", { required: true });
			const content = readStringParam(ctx.params, "content");
			const stickerIds = readStringArrayParam(ctx.params, "stickerIds", {
				required: true,
				label: "stickerIds"
			});
			await discordMessagingActionRuntime.sendStickerDiscord(to, stickerIds, ctx.withOpts({ content }));
			return jsonResult({ ok: true });
		}
		case "poll": {
			if (!ctx.isActionEnabled("polls")) throw new Error("Discord polls are disabled.");
			const to = readStringParam(ctx.params, "to", { required: true });
			const content = readStringParam(ctx.params, "content");
			const question = readStringParam(ctx.params, "question", { required: true });
			const answers = readStringArrayParam(ctx.params, "answers", {
				required: true,
				label: "answers"
			});
			const allowMultiselect = readBooleanParam(ctx.params, "allowMultiselect");
			const durationHours = readNumberParam(ctx.params, "durationHours");
			const maxSelections = resolvePollMaxSelections(answers.length, allowMultiselect);
			await discordMessagingActionRuntime.sendPollDiscord(to, {
				question,
				options: answers,
				maxSelections,
				durationHours
			}, ctx.withOpts({ content }));
			return jsonResult({ ok: true });
		}
		case "sendMessage": {
			if (!ctx.isActionEnabled("messages")) throw new Error("Discord message sends are disabled.");
			const to = readStringParam(ctx.params, "to", { required: true });
			const asVoice = ctx.params.asVoice === true;
			const silent = ctx.params.silent === true;
			const rawComponents = ctx.params.components;
			const componentSpec = hasDiscordComponentObjectKeys(rawComponents) ? discordMessagingActionRuntime.readDiscordComponentSpec(rawComponents) : null;
			const components = Array.isArray(rawComponents) || typeof rawComponents === "function" ? rawComponents : void 0;
			const mediaUrl = readStringParam(ctx.params, "mediaUrl", { trim: false }) ?? readStringParam(ctx.params, "path", { trim: false }) ?? readStringParam(ctx.params, "filePath", { trim: false });
			const content = readStringParam(ctx.params, "content", {
				required: !asVoice && !componentSpec && !components && !mediaUrl,
				allowEmpty: true
			});
			const filename = readStringParam(ctx.params, "filename");
			const replyTo = readStringParam(ctx.params, "replyTo");
			const rawEmbeds = ctx.params.embeds;
			const embeds = Array.isArray(rawEmbeds) ? rawEmbeds : void 0;
			const sessionKey = readStringParam(ctx.params, "__sessionKey");
			const agentId = readStringParam(ctx.params, "__agentId");
			if (componentSpec) {
				if (asVoice) throw new Error("Discord components cannot be sent as voice messages.");
				if (embeds?.length) throw new Error("Discord components cannot include embeds.");
				const normalizedContent = content?.trim() ? content : void 0;
				const payload = componentSpec.text ? componentSpec : {
					...componentSpec,
					text: normalizedContent
				};
				return jsonResult({
					ok: true,
					result: await discordMessagingActionRuntime.sendDiscordComponentMessage(to, payload, {
						...ctx.withOpts(),
						silent,
						replyTo: replyTo ?? void 0,
						sessionKey: sessionKey ?? void 0,
						agentId: agentId ?? void 0,
						mediaUrl: mediaUrl ?? void 0,
						filename: filename ?? void 0,
						mediaAccess: ctx.options?.mediaAccess,
						mediaLocalRoots: ctx.options?.mediaLocalRoots,
						mediaReadFile: ctx.options?.mediaReadFile
					}),
					components: true
				});
			}
			if (asVoice) {
				if (!mediaUrl) throw new Error("Voice messages require a media file reference (mediaUrl, path, or filePath).");
				if (content && content.trim()) throw new Error("Voice messages cannot include text content (Discord limitation). Remove the content parameter.");
				assertMediaNotDataUrl(mediaUrl);
				return jsonResult({
					ok: true,
					result: await discordMessagingActionRuntime.sendVoiceMessageDiscord(to, mediaUrl, {
						...ctx.withOpts(),
						replyTo,
						silent
					}),
					voiceMessage: true
				});
			}
			return jsonResult({
				ok: true,
				result: await discordMessagingActionRuntime.sendMessageDiscord(to, content ?? "", {
					...ctx.withOpts(),
					mediaAccess: ctx.options?.mediaAccess,
					mediaUrl,
					filename: filename ?? void 0,
					mediaLocalRoots: ctx.options?.mediaLocalRoots,
					mediaReadFile: ctx.options?.mediaReadFile,
					replyTo,
					components,
					embeds,
					silent
				})
			});
		}
		case "threadCreate": {
			if (!ctx.isActionEnabled("threads")) throw new Error("Discord threads are disabled.");
			const channelId = ctx.resolveChannelId();
			const name = readStringParam(ctx.params, "name", { required: true });
			const messageId = readStringParam(ctx.params, "messageId");
			const content = readStringParam(ctx.params, "content");
			const payload = {
				name,
				messageId,
				autoArchiveMinutes: readNumberParam(ctx.params, "autoArchiveMinutes"),
				content,
				appliedTags: readStringArrayParam(ctx.params, "appliedTags") ?? void 0
			};
			try {
				return jsonResult({
					ok: true,
					thread: await discordMessagingActionRuntime.createThreadDiscord(channelId, payload, ctx.withOpts())
				});
			} catch (error) {
				if (error instanceof DiscordThreadInitialMessageError) return jsonResult({
					ok: true,
					partial: true,
					thread: error.thread,
					warning: "Discord thread was created, but sending the initial message failed.",
					initialMessageError: error.initialMessageError
				});
				throw error;
			}
		}
		case "threadList": {
			if (!ctx.isActionEnabled("threads")) throw new Error("Discord threads are disabled.");
			const guildId = readStringParam(ctx.params, "guildId", { required: true });
			const channelId = readStringParam(ctx.params, "channelId");
			const includeArchived = readBooleanParam(ctx.params, "includeArchived");
			const before = readStringParam(ctx.params, "before");
			const limit = readNumberParam(ctx.params, "limit");
			return jsonResult({
				ok: true,
				threads: await discordMessagingActionRuntime.listThreadsDiscord({
					guildId,
					channelId,
					includeArchived,
					before,
					limit
				}, ctx.withOpts())
			});
		}
		case "threadReply": {
			if (!ctx.isActionEnabled("threads")) throw new Error("Discord threads are disabled.");
			const channelId = ctx.resolveChannelId();
			const content = readStringParam(ctx.params, "content", { required: true });
			const mediaUrl = readStringParam(ctx.params, "mediaUrl");
			const replyTo = readStringParam(ctx.params, "replyTo");
			return jsonResult({
				ok: true,
				result: await discordMessagingActionRuntime.sendMessageDiscord(`channel:${channelId}`, content, {
					...ctx.withOpts(),
					mediaUrl,
					mediaLocalRoots: ctx.options?.mediaLocalRoots,
					mediaReadFile: ctx.options?.mediaReadFile,
					replyTo
				})
			});
		}
		default: return;
	}
}
//#endregion
//#region extensions/discord/src/actions/runtime.messaging.shared.ts
function createDiscordMessagingActionContext(params) {
	const accountId = readStringParam(params.input, "accountId");
	const cfgOptions = { cfg: params.cfg };
	const withOpts = (extra) => createDiscordActionOptions({
		cfg: params.cfg,
		accountId,
		extra
	});
	const resolvedReactionAccountId = accountId ?? resolveDefaultDiscordAccountId(params.cfg);
	const reactionRuntimeOptions = resolvedReactionAccountId ? createDiscordRuntimeAccountContext({
		cfg: params.cfg,
		accountId: resolvedReactionAccountId
	}) : cfgOptions;
	return {
		action: params.action,
		params: params.input,
		isActionEnabled: params.isActionEnabled,
		cfg: params.cfg,
		options: params.options,
		accountId,
		resolveChannelId: () => discordMessagingActionRuntime.resolveDiscordChannelId(readStringParam(params.input, "channelId", { required: true })),
		resolveReactionChannelId: async () => {
			const target = readStringParam(params.input, "channelId") ?? readStringParam(params.input, "to", { required: true });
			return await discordMessagingActionRuntime.resolveDiscordReactionTargetChannelId({
				target,
				cfg: params.cfg,
				accountId: resolvedReactionAccountId
			});
		},
		withOpts,
		withReactionRuntimeOptions: (extra) => ({
			...reactionRuntimeOptions ?? cfgOptions,
			...extra
		}),
		normalizeMessage: (message) => {
			if (!message || typeof message !== "object") return message;
			return withNormalizedTimestamp(message, message.timestamp);
		}
	};
}
//#endregion
//#region extensions/discord/src/actions/runtime.messaging.ts
async function handleDiscordMessagingAction(action, params, isActionEnabled, cfg, options) {
	if (!cfg) throw new Error("Discord messaging actions require a resolved runtime config.");
	const ctx = createDiscordMessagingActionContext({
		action,
		input: params,
		isActionEnabled,
		cfg,
		options
	});
	return await handleDiscordReactionMessagingAction(ctx) ?? await handleDiscordMessageSendAction(ctx) ?? await handleDiscordMessageManagementAction(ctx) ?? (() => {
		throw new Error(`Unknown action: ${action}`);
	})();
}
//#endregion
//#region extensions/discord/src/actions/runtime.moderation-shared.ts
const moderationPermissions = {
	timeout: PermissionFlagsBits.ModerateMembers,
	kick: PermissionFlagsBits.KickMembers,
	ban: PermissionFlagsBits.BanMembers
};
function isDiscordModerationAction(action) {
	return action === "timeout" || action === "kick" || action === "ban";
}
function requiredGuildPermissionForModerationAction(action) {
	return moderationPermissions[action];
}
function readDiscordModerationCommand(action, params) {
	if (!isDiscordModerationAction(action)) throw new Error(`Unsupported Discord moderation action: ${action}`);
	return {
		action,
		guildId: readStringParam(params, "guildId", { required: true }),
		userId: readStringParam(params, "userId", { required: true }),
		durationMinutes: readNumberParam(params, "durationMinutes", { integer: true }),
		until: readStringParam(params, "until"),
		reason: readStringParam(params, "reason"),
		deleteMessageDays: readNumberParam(params, "deleteMessageDays", { integer: true })
	};
}
//#endregion
//#region extensions/discord/src/actions/runtime.moderation.ts
const discordModerationActionRuntime = {
	banMemberDiscord,
	hasAnyGuildPermissionDiscord,
	kickMemberDiscord,
	timeoutMemberDiscord
};
async function verifySenderModerationPermission(params) {
	if (!params.senderUserId) return;
	if (!await discordModerationActionRuntime.hasAnyGuildPermissionDiscord(params.guildId, params.senderUserId, [params.requiredPermission], createDiscordActionOptions({
		cfg: params.cfg,
		accountId: params.accountId
	}))) throw new Error("Sender does not have required permissions for this moderation action.");
}
async function handleDiscordModerationAction(action, params, isActionEnabled, cfg) {
	if (!isDiscordModerationAction(action)) throw new Error(`Unknown action: ${action}`);
	if (!isActionEnabled("moderation", false)) throw new Error("Discord moderation is disabled.");
	if (!cfg) throw new Error("Discord moderation actions require a resolved runtime config.");
	const accountId = readStringParam(params, "accountId");
	const command = readDiscordModerationCommand(action, params);
	const senderUserId = readStringParam(params, "senderUserId");
	const withOpts = () => createDiscordActionOptions({
		cfg,
		accountId
	});
	await verifySenderModerationPermission({
		guildId: command.guildId,
		senderUserId,
		requiredPermission: requiredGuildPermissionForModerationAction(command.action),
		accountId,
		cfg
	});
	switch (command.action) {
		case "timeout": return jsonResult({
			ok: true,
			member: await discordModerationActionRuntime.timeoutMemberDiscord({
				guildId: command.guildId,
				userId: command.userId,
				durationMinutes: command.durationMinutes,
				until: command.until,
				reason: command.reason
			}, withOpts())
		});
		case "kick":
			await discordModerationActionRuntime.kickMemberDiscord({
				guildId: command.guildId,
				userId: command.userId,
				reason: command.reason
			}, withOpts());
			return jsonResult({ ok: true });
		case "ban":
			await discordModerationActionRuntime.banMemberDiscord({
				guildId: command.guildId,
				userId: command.userId,
				reason: command.reason,
				deleteMessageDays: command.deleteMessageDays
			}, withOpts());
			return jsonResult({ ok: true });
	}
	throw new Error("Unsupported Discord moderation action");
}
//#endregion
//#region extensions/discord/src/actions/runtime.presence.ts
const ACTIVITY_TYPE_MAP = {
	playing: 0,
	streaming: 1,
	listening: 2,
	watching: 3,
	custom: 4,
	competing: 5
};
const VALID_STATUSES = new Set([
	"online",
	"dnd",
	"idle",
	"invisible"
]);
async function handleDiscordPresenceAction(action, params, isActionEnabled) {
	if (action !== "setPresence") throw new Error(`Unknown presence action: ${action}`);
	if (!isActionEnabled("presence", false)) throw new Error("Discord presence changes are disabled.");
	const accountId = readStringParam(params, "accountId");
	const gateway = getGateway(accountId);
	if (!gateway) throw new Error(`Discord gateway not available${accountId ? ` for account "${accountId}"` : ""}. The bot may not be connected.`);
	if (!gateway.isConnected) throw new Error(`Discord gateway is not connected${accountId ? ` for account "${accountId}"` : ""}.`);
	const statusRaw = readStringParam(params, "status") ?? "online";
	if (!VALID_STATUSES.has(statusRaw)) throw new Error(`Invalid status "${statusRaw}". Must be one of: ${[...VALID_STATUSES].join(", ")}`);
	const status = statusRaw;
	const activityTypeRaw = readStringParam(params, "activityType");
	const activityName = readStringParam(params, "activityName");
	const activities = [];
	if (activityTypeRaw || activityName) {
		if (!activityTypeRaw) throw new Error(`activityType is required when activityName is provided. Valid types: ${Object.keys(ACTIVITY_TYPE_MAP).join(", ")}`);
		const typeNum = ACTIVITY_TYPE_MAP[normalizeLowercaseStringOrEmpty(activityTypeRaw)];
		if (typeNum === void 0) throw new Error(`Invalid activityType "${activityTypeRaw}". Must be one of: ${Object.keys(ACTIVITY_TYPE_MAP).join(", ")}`);
		const activity = {
			name: activityName ?? "",
			type: typeNum
		};
		if (typeNum === 1) {
			const url = readStringParam(params, "activityUrl");
			if (url) activity.url = url;
		}
		const state = readStringParam(params, "activityState");
		if (state) activity.state = state;
		activities.push(activity);
	}
	const presenceData = {
		since: null,
		activities,
		status,
		afk: false
	};
	gateway.updatePresence(presenceData);
	return jsonResult({
		ok: true,
		status,
		activities: activities.map((a) => Object.assign({
			type: a.type,
			name: a.name
		}, a.url ? { url: a.url } : {}, a.state ? { state: a.state } : {}))
	});
}
//#endregion
//#region extensions/discord/src/actions/runtime.ts
const messagingActions = new Set([
	"react",
	"reactions",
	"sticker",
	"poll",
	"permissions",
	"fetchMessage",
	"readMessages",
	"sendMessage",
	"editMessage",
	"deleteMessage",
	"threadCreate",
	"threadList",
	"threadReply",
	"pinMessage",
	"unpinMessage",
	"listPins",
	"searchMessages"
]);
const guildActions = new Set([
	"memberInfo",
	"roleInfo",
	"emojiList",
	"emojiUpload",
	"stickerUpload",
	"roleAdd",
	"roleRemove",
	"channelInfo",
	"channelList",
	"voiceStatus",
	"eventList",
	"eventCreate",
	"channelCreate",
	"channelEdit",
	"channelDelete",
	"channelMove",
	"categoryCreate",
	"categoryEdit",
	"categoryDelete",
	"channelPermissionSet",
	"channelPermissionRemove"
]);
const moderationActions = new Set([
	"timeout",
	"kick",
	"ban"
]);
const presenceActions = new Set(["setPresence"]);
async function handleDiscordAction(params, cfg, options) {
	const action = readStringParam(params, "action", { required: true });
	const isActionEnabled = createDiscordActionGate({
		cfg,
		accountId: readStringParam(params, "accountId")
	});
	if (messagingActions.has(action)) return await handleDiscordMessagingAction(action, params, isActionEnabled, cfg, options);
	if (guildActions.has(action)) return await handleDiscordGuildAction(action, params, isActionEnabled, cfg, options);
	if (moderationActions.has(action)) return await handleDiscordModerationAction(action, params, isActionEnabled, cfg);
	if (presenceActions.has(action)) return await handleDiscordPresenceAction(action, params, isActionEnabled);
	throw new Error(`Unknown action: ${action}`);
}
//#endregion
export { readDiscordChannelCreateParams as a, readDiscordParentIdParam as c, requiredGuildPermissionForModerationAction as i, isDiscordModerationAction as n, readDiscordChannelEditParams as o, readDiscordModerationCommand as r, readDiscordChannelMoveParams as s, handleDiscordAction as t };
