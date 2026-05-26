import { l as normalizeOptionalStringifiedId } from "./string-coerce-DyL154ka.js";
import { c as normalizeInteractiveReply, l as normalizeMessagePresentation } from "./payload-BDV15CYA.js";
import { f as readNumberParam, g as readStringParam, m as readStringArrayParam } from "./common-E9YpX7pB.js";
import { t as readBooleanParam } from "./boolean-param-Ch5dc2FQ.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./agent-runtime-Lc7H-PlR.js";
import { r as resolveReactionMessageId } from "./channel-actions-DMN7G5RZ.js";
import { n as resolveDiscordChannelId } from "./target-parsing-D1FhMbX6.js";
import { t as handleDiscordAction } from "./runtime-CQtJkUNc.js";
import { n as buildDiscordPresentationComponents, t as buildDiscordInteractiveComponents } from "./shared-interactive-COmUlOXv.js";
import "./targets-B8AIYxNL.js";
import "./action-runtime-api-sAbWccIF.js";
import { r as notifyDiscordInboundEventOutboundSuccess } from "./inbound-event-delivery-DTGIjZVJ.js";
import { t as tryHandleDiscordMessageActionGuildAdmin } from "./handle-action.guild-admin-Deq2m3sd.js";
//#region extensions/discord/src/actions/handle-action.ts
const providerId = "discord";
function readCurrentDiscordTarget(toolContext) {
	const provider = toolContext?.currentChannelProvider?.trim().toLowerCase();
	if (provider && provider !== providerId) return;
	return toolContext?.currentChannelId?.trim() || void 0;
}
async function handleDiscordMessageAction(ctx) {
	const { action, params, cfg } = ctx;
	const accountId = ctx.accountId ?? readStringParam(params, "accountId");
	const actionOptions = {
		mediaAccess: ctx.mediaAccess,
		mediaLocalRoots: ctx.mediaLocalRoots,
		mediaReadFile: ctx.mediaReadFile
	};
	const notifyVisibleOutbound = (to, fallbackSessionKey) => notifyDiscordInboundEventOutboundSuccess({
		sessionKey: ctx.sessionKey ?? fallbackSessionKey ?? void 0,
		to,
		accountId,
		inboundEventKind: ctx.inboundEventKind
	});
	const readTarget = () => {
		const target = readStringParam(params, "channelId") ?? readStringParam(params, "to") ?? readCurrentDiscordTarget(ctx.toolContext);
		if (!target) throw new Error("Discord channel target is required (use channel:<id>).");
		return target;
	};
	const resolveChannelId = () => resolveDiscordChannelId(readTarget());
	const readSendTarget = () => {
		const target = readStringParam(params, "to") ?? readStringParam(params, "target") ?? readCurrentDiscordTarget(ctx.toolContext);
		if (!target) throw new Error("Discord channel target is required (use channel:<id>).");
		return target;
	};
	if (action === "send") {
		const to = readSendTarget();
		const asVoice = readBooleanParam(params, "asVoice") === true;
		const rawComponents = params.components ?? buildDiscordPresentationComponents(normalizeMessagePresentation(params.presentation)) ?? buildDiscordInteractiveComponents(normalizeInteractiveReply(params.interactive));
		const hasComponents = Boolean(rawComponents) && (typeof rawComponents === "function" || typeof rawComponents === "object");
		const components = hasComponents ? rawComponents : void 0;
		const mediaUrl = readStringParam(params, "media", { trim: false }) ?? readStringParam(params, "path", { trim: false }) ?? readStringParam(params, "filePath", { trim: false });
		const content = readStringParam(params, "message", {
			required: !asVoice && !hasComponents && !mediaUrl,
			allowEmpty: true
		});
		const filename = readStringParam(params, "filename");
		const replyTo = readStringParam(params, "replyTo");
		const rawEmbeds = params.embeds;
		const embeds = Array.isArray(rawEmbeds) ? rawEmbeds : void 0;
		const silent = readBooleanParam(params, "silent") === true;
		const suppressEmbeds = readBooleanParam(params, "suppressEmbeds");
		const sessionKey = readStringParam(params, "__sessionKey");
		const agentId = readStringParam(params, "__agentId");
		const threadName = readStringParam(params, "threadName");
		const result = await handleDiscordAction({
			action: "sendMessage",
			accountId: accountId ?? void 0,
			to,
			content: content ?? "",
			...threadName ? { threadName } : {},
			mediaUrl: mediaUrl ?? void 0,
			filename: filename ?? void 0,
			replyTo: replyTo ?? void 0,
			components,
			embeds,
			asVoice,
			silent,
			...suppressEmbeds === void 0 ? {} : { suppressEmbeds },
			__sessionKey: sessionKey ?? void 0,
			__agentId: agentId ?? void 0
		}, cfg, actionOptions);
		notifyVisibleOutbound(to, sessionKey);
		return result;
	}
	if (action === "upload-file") {
		const to = readSendTarget();
		const mediaUrl = readStringParam(params, "filePath", { trim: false }) ?? readStringParam(params, "path", { trim: false }) ?? readStringParam(params, "media", { trim: false });
		if (!mediaUrl) throw new Error("upload-file requires filePath, path, or media.");
		const content = readStringParam(params, "message", { allowEmpty: true }) ?? readStringParam(params, "content", { allowEmpty: true });
		const filename = readStringParam(params, "filename");
		const replyTo = readStringParam(params, "replyTo");
		const silent = readBooleanParam(params, "silent") === true;
		const suppressEmbeds = readBooleanParam(params, "suppressEmbeds");
		const sessionKey = readStringParam(params, "__sessionKey");
		const agentId = readStringParam(params, "__agentId");
		const result = await handleDiscordAction({
			action: "sendMessage",
			accountId: accountId ?? void 0,
			to,
			content: content ?? "",
			mediaUrl,
			filename: filename ?? void 0,
			replyTo: replyTo ?? void 0,
			silent,
			...suppressEmbeds === void 0 ? {} : { suppressEmbeds },
			__sessionKey: sessionKey ?? void 0,
			__agentId: agentId ?? void 0
		}, cfg, actionOptions);
		notifyVisibleOutbound(to, sessionKey);
		return result;
	}
	if (action === "poll") {
		const to = readStringParam(params, "to", { required: true });
		const question = readStringParam(params, "pollQuestion", { required: true });
		const answers = readStringArrayParam(params, "pollOption", { required: true });
		const allowMultiselect = readBooleanParam(params, "pollMulti");
		const durationHours = readNumberParam(params, "pollDurationHours", {
			integer: true,
			strict: true
		});
		const result = await handleDiscordAction({
			action: "poll",
			accountId: accountId ?? void 0,
			to,
			question,
			answers,
			allowMultiselect,
			durationHours: durationHours ?? void 0,
			content: readStringParam(params, "message")
		}, cfg, actionOptions);
		notifyVisibleOutbound(to);
		return result;
	}
	if (action === "react") {
		const messageId = normalizeOptionalStringifiedId(resolveReactionMessageId({
			args: params,
			toolContext: ctx.toolContext
		})) ?? "";
		if (!messageId) throw new Error("messageId required. Provide messageId explicitly or react to the current inbound message.");
		const emoji = readStringParam(params, "emoji", { allowEmpty: true });
		const remove = readBooleanParam(params, "remove");
		return await handleDiscordAction({
			action: "react",
			accountId: accountId ?? void 0,
			channelId: readTarget(),
			messageId,
			emoji,
			remove
		}, cfg, actionOptions);
	}
	if (action === "reactions") {
		const messageId = readStringParam(params, "messageId", { required: true });
		const limit = readNumberParam(params, "limit", { integer: true });
		return await handleDiscordAction({
			action: "reactions",
			accountId: accountId ?? void 0,
			channelId: readTarget(),
			messageId,
			limit
		}, cfg, actionOptions);
	}
	if (action === "read") {
		const limit = readNumberParam(params, "limit", { integer: true });
		return await handleDiscordAction({
			action: "readMessages",
			accountId: accountId ?? void 0,
			channelId: resolveChannelId(),
			limit,
			before: readStringParam(params, "before"),
			after: readStringParam(params, "after"),
			around: readStringParam(params, "around")
		}, cfg, actionOptions);
	}
	if (action === "edit") {
		const messageId = readStringParam(params, "messageId", { required: true });
		const content = readStringParam(params, "message", { required: true });
		return await handleDiscordAction({
			action: "editMessage",
			accountId: accountId ?? void 0,
			channelId: resolveChannelId(),
			messageId,
			content
		}, cfg, actionOptions);
	}
	if (action === "delete") {
		const messageId = readStringParam(params, "messageId", { required: true });
		return await handleDiscordAction({
			action: "deleteMessage",
			accountId: accountId ?? void 0,
			channelId: resolveChannelId(),
			messageId
		}, cfg, actionOptions);
	}
	if (action === "pin" || action === "unpin" || action === "list-pins") {
		const messageId = action === "list-pins" ? void 0 : readStringParam(params, "messageId", { required: true });
		return await handleDiscordAction({
			action: action === "pin" ? "pinMessage" : action === "unpin" ? "unpinMessage" : "listPins",
			accountId: accountId ?? void 0,
			channelId: resolveChannelId(),
			messageId
		}, cfg, actionOptions);
	}
	if (action === "permissions") return await handleDiscordAction({
		action: "permissions",
		accountId: accountId ?? void 0,
		channelId: resolveChannelId()
	}, cfg, actionOptions);
	if (action === "thread-create") {
		const name = readStringParam(params, "threadName", { required: true });
		const messageId = readStringParam(params, "messageId");
		const content = readStringParam(params, "message");
		const autoArchiveMinutes = readNumberParam(params, "autoArchiveMin", { integer: true });
		const appliedTags = readStringArrayParam(params, "appliedTags");
		const result = await handleDiscordAction({
			action: "threadCreate",
			accountId: accountId ?? void 0,
			channelId: resolveChannelId(),
			name,
			messageId,
			content,
			autoArchiveMinutes,
			appliedTags: appliedTags ?? void 0
		}, cfg, actionOptions);
		notifyVisibleOutbound(resolveChannelId());
		return result;
	}
	if (action === "sticker") {
		const to = readStringParam(params, "to", { required: true });
		const stickerIds = readStringArrayParam(params, "stickerId", {
			required: true,
			label: "sticker-id"
		}) ?? [];
		const result = await handleDiscordAction({
			action: "sticker",
			accountId: accountId ?? void 0,
			to,
			stickerIds,
			content: readStringParam(params, "message")
		}, cfg, actionOptions);
		notifyVisibleOutbound(to);
		return result;
	}
	if (action === "set-presence") return await handleDiscordAction({
		action: "setPresence",
		accountId: accountId ?? void 0,
		status: readStringParam(params, "status"),
		activityType: readStringParam(params, "activityType"),
		activityName: readStringParam(params, "activityName"),
		activityUrl: readStringParam(params, "activityUrl"),
		activityState: readStringParam(params, "activityState")
	}, cfg, actionOptions);
	const adminResult = await tryHandleDiscordMessageActionGuildAdmin({
		ctx,
		resolveChannelId
	});
	if (adminResult !== void 0) {
		if (action === "thread-reply") notifyVisibleOutbound(readStringParam(params, "threadId") ?? readTarget());
		return adminResult;
	}
	throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
}
//#endregion
export { handleDiscordMessageAction };
