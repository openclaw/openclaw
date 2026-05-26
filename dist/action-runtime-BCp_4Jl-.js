import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { n as isSingleUseReplyToMode } from "./reply-reference-BWpe6PiT.js";
import { _ as readStringParam, a as createActionGate, c as imageResultFromFile, l as jsonResult, m as readReactionParams, p as readNumberParam } from "./common-V7-zd73S.js";
import { t as readBooleanParam } from "./boolean-param-58y-fOZr.js";
import { a as withNormalizedTimestamp } from "./date-time-D45sDlB1.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import "./reply-reference-B2sOmJ2G.js";
import { i as resolveSlackChannelId, r as parseSlackTarget } from "./target-parsing-V_XPO9_R.js";
import { n as parseSlackBlocksInput } from "./blocks-input-BkCFIqct.js";
import "./runtime-api-Di-QUXd_.js";
//#region extensions/slack/src/action-runtime.ts
const messagingActions = new Set([
	"sendMessage",
	"uploadFile",
	"editMessage",
	"deleteMessage",
	"readMessages",
	"downloadFile"
]);
const reactionsActions = new Set(["react", "reactions"]);
const pinActions = new Set([
	"pinMessage",
	"unpinMessage",
	"listPins"
]);
function sameSlackChannelTarget(targetChannel, currentChannelId) {
	const parsedTarget = parseSlackTarget(targetChannel, { defaultKind: "channel" });
	if (!parsedTarget || parsedTarget.kind !== "channel") return false;
	return normalizeLowercaseStringOrEmpty(parsedTarget.id) === normalizeLowercaseStringOrEmpty(currentChannelId);
}
let slackActionsRuntimePromise;
let slackAccountsRuntimePromise;
function loadSlackActionsRuntime() {
	slackActionsRuntimePromise ??= import("./actions.runtime-CkDWyjRw.js");
	return slackActionsRuntimePromise;
}
function loadSlackAccountsRuntime() {
	slackAccountsRuntimePromise ??= import("./accounts.runtime-rw2qPuCV.js");
	return slackAccountsRuntimePromise;
}
function createLazySlackAction(key) {
	return (async (...args) => {
		const action = (await loadSlackActionsRuntime())[key];
		return action(...args);
	});
}
const slackActionRuntime = {
	deleteSlackMessage: createLazySlackAction("deleteSlackMessage"),
	downloadSlackFile: createLazySlackAction("downloadSlackFile"),
	editSlackMessage: createLazySlackAction("editSlackMessage"),
	getSlackMemberInfo: createLazySlackAction("getSlackMemberInfo"),
	listSlackEmojis: createLazySlackAction("listSlackEmojis"),
	listSlackPins: createLazySlackAction("listSlackPins"),
	listSlackReactions: createLazySlackAction("listSlackReactions"),
	parseSlackBlocksInput,
	pinSlackMessage: createLazySlackAction("pinSlackMessage"),
	reactSlackMessage: createLazySlackAction("reactSlackMessage"),
	readSlackMessages: createLazySlackAction("readSlackMessages"),
	removeOwnSlackReactions: createLazySlackAction("removeOwnSlackReactions"),
	removeSlackReaction: createLazySlackAction("removeSlackReaction"),
	sendSlackMessage: createLazySlackAction("sendSlackMessage"),
	unpinSlackMessage: createLazySlackAction("unpinSlackMessage")
};
/**
* Resolve threadTs for a Slack message based on context and replyToMode.
* - "all": always inject threadTs
* - "first"/"batched": inject only for the first eligible message (updates hasRepliedRef)
* - "off": never auto-inject
*/
function resolveThreadTsFromContext(explicitThreadTs, targetChannel, context, opts) {
	if (explicitThreadTs) return explicitThreadTs;
	if (opts?.suppressImplicitThread) return;
	if (!context?.currentThreadTs || !context?.currentChannelId) return;
	if (!sameSlackChannelTarget(targetChannel, context.currentChannelId)) return;
	if (context.replyToMode === "all") return context.currentThreadTs;
	if (isSingleUseReplyToMode(context.replyToMode ?? "off") && context.hasRepliedRef && !context.hasRepliedRef.value) {
		context.hasRepliedRef.value = true;
		return context.currentThreadTs;
	}
}
function readSlackBlocksParam(params) {
	return slackActionRuntime.parseSlackBlocksInput(params.blocks);
}
function isImageContentType(value) {
	return value?.trim().toLowerCase().startsWith("image/") === true;
}
async function handleSlackAction(params, cfg, context) {
	const resolveChannelId = () => resolveSlackChannelId(readStringParam(params, "channelId", { required: true }));
	const action = readStringParam(params, "action", { required: true });
	const accountId = readStringParam(params, "accountId");
	const { resolveSlackAccount } = await loadSlackAccountsRuntime();
	const account = resolveSlackAccount({
		cfg,
		accountId
	});
	const isActionEnabled = createActionGate(account.actions ?? cfg.channels?.slack?.actions);
	const userToken = account.userToken;
	const botToken = account.botToken?.trim();
	const allowUserWrites = account.config.userTokenReadOnly === false;
	const getTokenForOperation = (operation) => {
		if (operation === "read") return userToken ?? botToken;
		if (!allowUserWrites) return botToken;
		return botToken ?? userToken;
	};
	const buildActionOpts = (operation) => {
		const token = getTokenForOperation(operation);
		const tokenOverride = token && token !== botToken ? token : void 0;
		return {
			cfg,
			...accountId ? { accountId } : {},
			...tokenOverride ? { token: tokenOverride } : {}
		};
	};
	const readOpts = buildActionOpts("read");
	const writeOpts = buildActionOpts("write");
	if (reactionsActions.has(action)) {
		if (!isActionEnabled("reactions")) throw new Error("Slack reactions are disabled.");
		const channelId = resolveChannelId();
		const messageId = readStringParam(params, "messageId", { required: true });
		if (action === "react") {
			const { emoji, remove, isEmpty } = readReactionParams(params, { removeErrorMessage: "Emoji is required to remove a Slack reaction." });
			if (remove) {
				if (writeOpts) await slackActionRuntime.removeSlackReaction(channelId, messageId, emoji, writeOpts);
				else await slackActionRuntime.removeSlackReaction(channelId, messageId, emoji);
				return jsonResult({
					ok: true,
					removed: emoji
				});
			}
			if (isEmpty) return jsonResult({
				ok: true,
				removed: writeOpts ? await slackActionRuntime.removeOwnSlackReactions(channelId, messageId, writeOpts) : await slackActionRuntime.removeOwnSlackReactions(channelId, messageId)
			});
			if (writeOpts) await slackActionRuntime.reactSlackMessage(channelId, messageId, emoji, writeOpts);
			else await slackActionRuntime.reactSlackMessage(channelId, messageId, emoji);
			return jsonResult({
				ok: true,
				added: emoji
			});
		}
		return jsonResult({
			ok: true,
			reactions: readOpts ? await slackActionRuntime.listSlackReactions(channelId, messageId, readOpts) : await slackActionRuntime.listSlackReactions(channelId, messageId)
		});
	}
	if (messagingActions.has(action)) {
		if (!isActionEnabled("messages")) throw new Error("Slack messages are disabled.");
		switch (action) {
			case "sendMessage": {
				const to = readStringParam(params, "to", { required: true });
				const content = readStringParam(params, "content", { allowEmpty: true });
				const mediaUrl = readStringParam(params, "mediaUrl");
				const blocks = readSlackBlocksParam(params);
				const replyBroadcast = readBooleanParam(params, "replyBroadcast");
				if (!content && !mediaUrl && !blocks) throw new Error("Slack sendMessage requires content, blocks, or mediaUrl.");
				if (replyBroadcast && mediaUrl) throw new Error("Slack replyBroadcast is only supported for text or block thread replies.");
				const threadTs = resolveThreadTsFromContext(readStringParam(params, "threadTs"), to, context, { suppressImplicitThread: params.topLevel === true || params.threadTs === null });
				const sendOpts = {
					...writeOpts,
					mediaLocalRoots: context?.mediaLocalRoots,
					mediaReadFile: context?.mediaReadFile,
					threadTs: threadTs ?? void 0,
					...replyBroadcast ? { replyBroadcast } : {}
				};
				const result = mediaUrl && blocks ? await (async () => {
					await slackActionRuntime.sendSlackMessage(to, "", {
						...sendOpts,
						mediaUrl
					});
					return await slackActionRuntime.sendSlackMessage(to, content ?? "", {
						...sendOpts,
						blocks
					});
				})() : await slackActionRuntime.sendSlackMessage(to, content ?? "", {
					...sendOpts,
					mediaUrl: mediaUrl ?? void 0,
					blocks
				});
				if (context?.hasRepliedRef && context.currentChannelId) {
					if (sameSlackChannelTarget(to, context.currentChannelId)) context.hasRepliedRef.value = true;
				}
				return jsonResult({
					ok: true,
					result
				});
			}
			case "uploadFile": {
				const to = readStringParam(params, "to", { required: true });
				const filePath = readStringParam(params, "filePath", {
					required: true,
					trim: false
				});
				const initialComment = readStringParam(params, "initialComment", { allowEmpty: true });
				const filename = readStringParam(params, "filename");
				const title = readStringParam(params, "title");
				if (readBooleanParam(params, "replyBroadcast")) throw new Error("Slack replyBroadcast is only supported for text or block thread replies.");
				const threadTs = resolveThreadTsFromContext(readStringParam(params, "threadTs"), to, context, { suppressImplicitThread: params.topLevel === true || params.threadTs === null });
				const result = await slackActionRuntime.sendSlackMessage(to, initialComment ?? "", {
					...writeOpts,
					mediaUrl: filePath,
					mediaLocalRoots: context?.mediaLocalRoots,
					mediaReadFile: context?.mediaReadFile,
					threadTs: threadTs ?? void 0,
					...filename ? { uploadFileName: filename } : {},
					...title ? { uploadTitle: title } : {}
				});
				if (context?.hasRepliedRef && context.currentChannelId) {
					if (sameSlackChannelTarget(to, context.currentChannelId)) context.hasRepliedRef.value = true;
				}
				return jsonResult({
					ok: true,
					result
				});
			}
			case "editMessage": {
				const channelId = resolveChannelId();
				const messageId = readStringParam(params, "messageId", { required: true });
				const content = readStringParam(params, "content", { allowEmpty: true });
				const blocks = readSlackBlocksParam(params);
				if (!content && !blocks) throw new Error("Slack editMessage requires content or blocks.");
				if (writeOpts) await slackActionRuntime.editSlackMessage(channelId, messageId, content ?? "", {
					...writeOpts,
					blocks
				});
				else await slackActionRuntime.editSlackMessage(channelId, messageId, content ?? "", { blocks });
				return jsonResult({ ok: true });
			}
			case "deleteMessage": {
				const channelId = resolveChannelId();
				const messageId = readStringParam(params, "messageId", { required: true });
				if (writeOpts) await slackActionRuntime.deleteSlackMessage(channelId, messageId, writeOpts);
				else await slackActionRuntime.deleteSlackMessage(channelId, messageId);
				return jsonResult({ ok: true });
			}
			case "readMessages": {
				const channelId = resolveChannelId();
				const limitRaw = params.limit;
				const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? limitRaw : void 0;
				const before = readStringParam(params, "before");
				const after = readStringParam(params, "after");
				const threadId = readStringParam(params, "threadId");
				const messageId = readStringParam(params, "messageId");
				const result = await slackActionRuntime.readSlackMessages(channelId, {
					...readOpts,
					limit,
					before: before ?? void 0,
					after: after ?? void 0,
					threadId: threadId ?? void 0,
					messageId: messageId ?? void 0
				});
				return jsonResult({
					ok: true,
					messages: result.messages.map((message) => withNormalizedTimestamp(message, message.ts)),
					hasMore: result.hasMore
				});
			}
			case "downloadFile": {
				const fileId = readStringParam(params, "fileId", { required: true });
				const channelTarget = readStringParam(params, "channelId") ?? readStringParam(params, "to");
				const channelId = channelTarget ? resolveSlackChannelId(channelTarget) : void 0;
				const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
				const maxBytes = account.config?.mediaMaxMb ? account.config.mediaMaxMb * 1024 * 1024 : 20 * 1024 * 1024;
				const readToken = getTokenForOperation("read");
				const downloaded = await slackActionRuntime.downloadSlackFile(fileId, {
					...readOpts,
					...readToken && !readOpts?.token ? { token: readToken } : {},
					maxBytes,
					channelId,
					threadId: threadId ?? void 0
				});
				if (!downloaded) return jsonResult({
					ok: false,
					error: "File could not be downloaded (not found, too large, or inaccessible)."
				});
				if (!isImageContentType(downloaded.contentType)) return jsonResult({
					ok: true,
					fileId,
					path: downloaded.path,
					contentType: downloaded.contentType,
					placeholder: downloaded.placeholder,
					media: {
						mediaUrl: downloaded.path,
						...downloaded.contentType ? { contentType: downloaded.contentType } : {}
					}
				});
				return await imageResultFromFile({
					label: "slack-file",
					path: downloaded.path,
					extraText: downloaded.placeholder,
					details: {
						fileId,
						path: downloaded.path,
						...downloaded.contentType ? { contentType: downloaded.contentType } : {}
					}
				});
			}
			default: break;
		}
	}
	if (pinActions.has(action)) {
		if (!isActionEnabled("pins")) throw new Error("Slack pins are disabled.");
		const channelId = resolveChannelId();
		if (action === "pinMessage") {
			const messageId = readStringParam(params, "messageId", { required: true });
			if (writeOpts) await slackActionRuntime.pinSlackMessage(channelId, messageId, writeOpts);
			else await slackActionRuntime.pinSlackMessage(channelId, messageId);
			return jsonResult({ ok: true });
		}
		if (action === "unpinMessage") {
			const messageId = readStringParam(params, "messageId", { required: true });
			if (writeOpts) await slackActionRuntime.unpinSlackMessage(channelId, messageId, writeOpts);
			else await slackActionRuntime.unpinSlackMessage(channelId, messageId);
			return jsonResult({ ok: true });
		}
		return jsonResult({
			ok: true,
			pins: (writeOpts ? await slackActionRuntime.listSlackPins(channelId, readOpts) : await slackActionRuntime.listSlackPins(channelId)).map((pin) => {
				const message = pin.message ? withNormalizedTimestamp(pin.message, pin.message.ts) : pin.message;
				return message ? Object.assign({}, pin, { message }) : pin;
			})
		});
	}
	if (action === "memberInfo") {
		if (!isActionEnabled("memberInfo")) throw new Error("Slack member info is disabled.");
		const userId = readStringParam(params, "userId", { required: true });
		return jsonResult({
			ok: true,
			info: writeOpts ? await slackActionRuntime.getSlackMemberInfo(userId, readOpts) : await slackActionRuntime.getSlackMemberInfo(userId)
		});
	}
	if (action === "emojiList") {
		if (!isActionEnabled("emojiList")) throw new Error("Slack emoji list is disabled.");
		const result = readOpts ? await slackActionRuntime.listSlackEmojis(readOpts) : await slackActionRuntime.listSlackEmojis();
		const limit = readNumberParam(params, "limit", { integer: true });
		if (limit != null && limit > 0 && result.emoji != null) {
			const entries = Object.entries(result.emoji).toSorted(([a], [b]) => a.localeCompare(b));
			if (entries.length > limit) return jsonResult({
				ok: true,
				emojis: {
					...result,
					emoji: Object.fromEntries(entries.slice(0, limit))
				}
			});
		}
		return jsonResult({
			ok: true,
			emojis: result
		});
	}
	throw new Error(`Unknown action: ${action}`);
}
//#endregion
export { slackActionRuntime as n, handleSlackAction as t };
