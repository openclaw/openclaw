import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { n as resolveChannelGroupRequireMention, r as resolveChannelGroupToolsPolicy } from "./group-policy-sKF5rlUN.js";
import { i as createLazyRuntimeNamedExport } from "./lazy-runtime-D-7_JraP.js";
import { c as jsonResult, f as readNumberParam, g as readStringParam, i as createActionGate, p as readReactionParams } from "./common-E9YpX7pB.js";
import { t as readBooleanParam } from "./boolean-param-Ch5dc2FQ.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./channel-policy-pv8ZpZxj.js";
import "./channel-actions-DMN7G5RZ.js";
import { t as extractToolSend } from "./tool-send-CH_ybyG1.js";
import { i as resolveIMessageAccount } from "./accounts-G6A_hywc.js";
import { n as IMESSAGE_ACTIONS, r as IMESSAGE_ACTION_NAMES, t as describeIMessageMessageTool } from "./message-tool-api-D1iehFu5.js";
import "./client-BcN4Qxqo.js";
import { t as getCachedIMessagePrivateApiStatus } from "./private-api-status-hXzk6Zzf.js";
import { c as parseIMessageTarget } from "./targets-C7radLf6.js";
import { r as rememberIMessageReplyCache, t as findLatestIMessageEntryForChat } from "./monitor-reply-cache-VQxHiKhg.js";
import "./probe-DlyCigli.js";
//#region extensions/imessage/src/actions.ts
const loadIMessageActionsRuntime = createLazyRuntimeNamedExport(() => import("./actions.runtime-kYSz_qnz.js"), "imessageActionsRuntime");
const log = createSubsystemLogger("channels/imessage");
const providerId = "imessage";
const SUPPORTED_ACTIONS = new Set([...IMESSAGE_ACTION_NAMES, "upload-file"]);
function readMessageText(params) {
	return readStringParam(params, "text") ?? readStringParam(params, "message");
}
function rememberOutboundBridgeMessage(params) {
	const messageId = params.messageId?.trim();
	if (!messageId || messageId === "ok" || messageId === "unknown") return;
	rememberIMessageReplyCache({
		accountId: params.accountId,
		messageId,
		chatGuid: params.chatGuid,
		timestamp: Date.now(),
		isFromMe: true
	});
}
/**
* Read messageId from the action params, falling back to the most recent
* inbound in the same chat when the caller omitted it. The natural intent
* for "react with 👍" or "tapback the last message" is the message that
* just arrived in the current conversation; making the agent re-quote a
* message id every time is friction the cache already has the answer for.
*/
function readMessageIdWithChatFallback(params, chatContext) {
	const explicit = readStringParam(params, "messageId");
	if (explicit) return explicit;
	const latest = findLatestIMessageEntryForChat(chatContext);
	if (latest?.messageId) return latest.messageId;
	return readStringParam(params, "messageId", { required: true });
}
async function resolveChatGuid(params) {
	const explicitChatGuid = readStringParam(params.actionParams, "chatGuid");
	if (explicitChatGuid) return explicitChatGuid;
	const explicitChatId = readNumberParam(params.actionParams, "chatId", { integer: true });
	if (typeof explicitChatId === "number") {
		const resolved = await params.runtime.resolveChatGuidForTarget({
			target: {
				kind: "chat_id",
				chatId: explicitChatId
			},
			options: params.options
		});
		if (resolved) return resolved;
		throw new Error(`iMessage ${params.action} failed: chatGuid not found for chat_id:<redacted>.`);
	}
	const explicitChatIdentifier = readStringParam(params.actionParams, "chatIdentifier");
	if (explicitChatIdentifier) {
		const resolved = await params.runtime.resolveChatGuidForTarget({
			target: {
				kind: "chat_identifier",
				chatIdentifier: explicitChatIdentifier
			},
			options: params.options
		});
		if (resolved) return resolved;
		throw new Error(`iMessage ${params.action} failed: chatGuid not found for chat_identifier:<redacted>.`);
	}
	const rawTarget = readStringParam(params.actionParams, "to") ?? readStringParam(params.actionParams, "target") ?? (params.currentChannelId?.trim() || void 0);
	if (rawTarget) {
		const target = parseIMessageTarget(rawTarget);
		if (target.kind === "chat_guid") return target.chatGuid;
		if (target.kind === "chat_id" || target.kind === "chat_identifier") {
			const resolved = await params.runtime.resolveChatGuidForTarget({
				target,
				options: params.options
			});
			if (resolved) return resolved;
			throw new Error(`iMessage ${params.action} failed: chatGuid not found for ${formatUnresolvedTarget(target)}.`);
		}
		if (target.kind === "handle") {
			const synthesizedIdentifier = `${target.service === "sms" ? "SMS" : "iMessage"};-;${target.to}`;
			const resolved = await params.runtime.resolveChatGuidForTarget({
				target: {
					kind: "chat_identifier",
					chatIdentifier: synthesizedIdentifier
				},
				options: params.options
			});
			if (resolved) return resolved;
			if (params.action === "react" || params.action === "edit" || params.action === "unsend") throw new Error(`iMessage ${params.action} requires a known chat. No registered chat for the supplied target; send a message first or pass an explicit chatGuid.`);
			return synthesizedIdentifier;
		}
	}
	throw new Error(`iMessage ${params.action} requires chatGuid, chatId, chatIdentifier, or a chat target.`);
}
function formatUnresolvedTarget(target) {
	return target.kind === "chat_id" ? "chat_id:<redacted>" : "chat_identifier:<redacted>";
}
function buildChatContextFromActionParams(params) {
	const explicitChatGuid = readStringParam(params.actionParams, "chatGuid")?.trim();
	const explicitChatIdentifier = readStringParam(params.actionParams, "chatIdentifier")?.trim();
	const explicitChatId = readNumberParam(params.actionParams, "chatId", { integer: true });
	const rawTarget = readStringParam(params.actionParams, "to") ?? readStringParam(params.actionParams, "target") ?? (params.currentChannelId?.trim() || void 0);
	const target = rawTarget ? parseIMessageTarget(rawTarget) : null;
	const handleChatIdentifier = target?.kind === "handle" ? `${target.service === "sms" ? "SMS" : "iMessage"};-;${target.to}` : void 0;
	return {
		chatGuid: explicitChatGuid || (target?.kind === "chat_guid" ? target.chatGuid : void 0),
		chatIdentifier: explicitChatIdentifier || (target?.kind === "chat_identifier" ? target.chatIdentifier : void 0) || handleChatIdentifier,
		chatId: typeof explicitChatId === "number" ? explicitChatId : target?.kind === "chat_id" ? target.chatId : void 0
	};
}
function mapTapbackReaction(emoji) {
	const value = normalizeOptionalLowercaseString(emoji)?.replace(/\ufe0f/g, "");
	if (!value) return;
	if ([
		"love",
		"heart",
		"❤",
		"❤️"
	].includes(value)) return "love";
	if ([
		"like",
		"+1",
		"thumbsup",
		"👍"
	].includes(value)) return "like";
	if ([
		"dislike",
		"-1",
		"thumbsdown",
		"👎"
	].includes(value)) return "dislike";
	if ([
		"laugh",
		"haha",
		"😂",
		"🤣"
	].includes(value)) return "laugh";
	if ([
		"emphasize",
		"!!",
		"‼",
		"‼️"
	].includes(value)) return "emphasize";
	if ([
		"question",
		"?",
		"？",
		"❓"
	].includes(value)) return "question";
}
function decodeBase64Buffer(params, action) {
	const base64Buffer = readStringParam(params, "buffer");
	if (!base64Buffer) throw new Error(`iMessage ${action} requires buffer (base64) parameter.`);
	return Uint8Array.from(Buffer.from(base64Buffer, "base64"));
}
const REPLY_ATTACHMENT_PATH_PARAM_NAMES = [
	"filePath",
	"path",
	"media",
	"mediaUrl",
	"fileUrl"
];
function extractReplyAttachment(params) {
	const buffer = readStringParam(params, "buffer");
	if (buffer) {
		const filename = readStringParam(params, "filename") ?? "attachment.bin";
		return {
			spec: {
				kind: "buffer",
				buffer: Uint8Array.from(Buffer.from(buffer, "base64")),
				filename
			},
			sourceParam: "buffer"
		};
	}
	for (const name of REPLY_ATTACHMENT_PATH_PARAM_NAMES) if (readStringParam(params, name)) return {
		spec: null,
		bypassParam: name
	};
	return null;
}
const KNOWN_EFFECT_IDS = new Set([
	"com.apple.MobileSMS.expressivesend.impact",
	"com.apple.MobileSMS.expressivesend.loud",
	"com.apple.MobileSMS.expressivesend.gentle",
	"com.apple.MobileSMS.expressivesend.invisibleink",
	"com.apple.MobileSMS.expressivesend.confetti",
	"com.apple.MobileSMS.expressivesend.lasers",
	"com.apple.MobileSMS.expressivesend.fireworks",
	"com.apple.MobileSMS.expressivesend.balloon",
	"com.apple.MobileSMS.expressivesend.heart",
	"com.apple.messages.effect.CKEchoEffect",
	"com.apple.messages.effect.CKHappyBirthdayEffect",
	"com.apple.messages.effect.CKShootingStarEffect",
	"com.apple.messages.effect.CKSparklesEffect",
	"com.apple.messages.effect.CKSpotlightEffect"
]);
function effectIdFromParam(raw) {
	const value = normalizeOptionalLowercaseString(raw);
	if (!value) return;
	const resolved = {
		slam: "com.apple.MobileSMS.expressivesend.impact",
		impact: "com.apple.MobileSMS.expressivesend.impact",
		loud: "com.apple.MobileSMS.expressivesend.loud",
		gentle: "com.apple.MobileSMS.expressivesend.gentle",
		"invisible-ink": "com.apple.MobileSMS.expressivesend.invisibleink",
		invisibleink: "com.apple.MobileSMS.expressivesend.invisibleink",
		confetti: "com.apple.MobileSMS.expressivesend.confetti",
		lasers: "com.apple.MobileSMS.expressivesend.lasers",
		fireworks: "com.apple.MobileSMS.expressivesend.fireworks",
		balloons: "com.apple.MobileSMS.expressivesend.balloon",
		balloon: "com.apple.MobileSMS.expressivesend.balloon",
		heart: "com.apple.MobileSMS.expressivesend.heart",
		echo: "com.apple.messages.effect.CKEchoEffect",
		happybirthday: "com.apple.messages.effect.CKHappyBirthdayEffect",
		"happy-birthday": "com.apple.messages.effect.CKHappyBirthdayEffect",
		shootingstar: "com.apple.messages.effect.CKShootingStarEffect",
		"shooting-star": "com.apple.messages.effect.CKShootingStarEffect",
		sparkles: "com.apple.messages.effect.CKSparklesEffect",
		spotlight: "com.apple.messages.effect.CKSpotlightEffect"
	}[value] ?? raw;
	if (typeof resolved === "string" && KNOWN_EFFECT_IDS.has(resolved)) return resolved;
	throw new Error(`iMessage sendWithEffect rejected unknown effect "${raw}". Use one of: slam, loud, gentle, invisibleink, confetti, lasers, fireworks, balloon, heart, echo, happybirthday, shootingstar, sparkles, spotlight (or the canonical com.apple.MobileSMS.expressivesend.* / com.apple.messages.effect.* identifier).`);
}
function assertActionEnabled(action, actionsConfig) {
	const spec = IMESSAGE_ACTIONS[action === "upload-file" ? "sendAttachment" : action];
	if (!spec?.gate || !createActionGate(actionsConfig)(spec.gate)) throw new Error(`iMessage ${action} is disabled in config.`);
}
const imessageMessageActions = {
	describeMessageTool: describeIMessageMessageTool,
	supportsAction: ({ action }) => SUPPORTED_ACTIONS.has(action),
	messageActionTargetAliases: {
		react: { aliases: [
			"chatGuid",
			"chatIdentifier",
			"chatId"
		] },
		edit: { aliases: [
			"chatGuid",
			"chatIdentifier",
			"chatId",
			"messageId"
		] },
		unsend: { aliases: [
			"chatGuid",
			"chatIdentifier",
			"chatId",
			"messageId"
		] },
		reply: { aliases: [
			"chatGuid",
			"chatIdentifier",
			"chatId",
			"messageId"
		] },
		sendWithEffect: { aliases: [
			"chatGuid",
			"chatIdentifier",
			"chatId"
		] },
		sendAttachment: { aliases: [
			"chatGuid",
			"chatIdentifier",
			"chatId"
		] },
		"upload-file": { aliases: [
			"chatGuid",
			"chatIdentifier",
			"chatId"
		] },
		renameGroup: { aliases: [
			"chatGuid",
			"chatIdentifier",
			"chatId"
		] },
		setGroupIcon: { aliases: [
			"chatGuid",
			"chatIdentifier",
			"chatId"
		] },
		addParticipant: { aliases: [
			"chatGuid",
			"chatIdentifier",
			"chatId"
		] },
		removeParticipant: { aliases: [
			"chatGuid",
			"chatIdentifier",
			"chatId"
		] },
		leaveGroup: { aliases: [
			"chatGuid",
			"chatIdentifier",
			"chatId"
		] }
	},
	extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
	handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
		const runtime = await loadIMessageActionsRuntime();
		const account = resolveIMessageAccount({
			cfg,
			accountId: accountId ?? void 0
		});
		assertActionEnabled(action, account.config.actions);
		const cliPathForProbe = account.config.cliPath?.trim() || "imsg";
		let privateApiStatus = getCachedIMessagePrivateApiStatus(cliPathForProbe);
		const assertPrivateApiEnabled = async () => {
			if (privateApiStatus?.available !== true) {
				const { probeIMessagePrivateApi } = await import("./probe-DE5EO92_.js");
				privateApiStatus = await probeIMessagePrivateApi(cliPathForProbe, account.config.probeTimeoutMs ?? 1e4);
			}
			if (!privateApiStatus?.available) {
				log.warn(`iMessage ${action} blocked: private API bridge unavailable (accountId=${account.accountId}, cliPath=${cliPathForProbe}). Run \`imsg launch\` to re-inject the dylib, then \`openclaw channels status\` to refresh.`);
				throw new Error(`iMessage ${action} requires the imsg private API bridge. Run imsg launch, then openclaw channels status to refresh capability detection.`);
			}
		};
		const opts = {
			cliPath: account.config.cliPath?.trim() || "imsg",
			dbPath: account.config.dbPath?.trim() || void 0,
			timeoutMs: account.config.probeTimeoutMs,
			chatGuid: ""
		};
		const chatGuid = async () => await resolveChatGuid({
			action,
			actionParams: params,
			currentChannelId: toolContext?.currentChannelId,
			runtime,
			options: opts
		});
		const messageId = (resolveOpts) => {
			const chatContext = buildChatContextFromActionParams({
				actionParams: params,
				currentChannelId: toolContext?.currentChannelId
			});
			const fallbackContext = {
				...chatContext,
				accountId: account.accountId
			};
			return runtime.resolveIMessageMessageId(readMessageIdWithChatFallback(params, fallbackContext), {
				requireKnownShortId: true,
				chatContext,
				...resolveOpts?.requireFromMe ? { requireFromMe: true } : {}
			});
		};
		if (action === "react") {
			await assertPrivateApiEnabled();
			const { emoji, remove, isEmpty } = readReactionParams(params, { removeErrorMessage: "Emoji is required to remove an iMessage reaction." });
			const reaction = mapTapbackReaction(emoji);
			const TAPBACK_KINDS = [
				"love",
				"like",
				"dislike",
				"laugh",
				"emphasize",
				"question"
			];
			if (!remove && (isEmpty || !reaction)) throw new Error("iMessage react supports love, like, dislike, laugh, emphasize, and question tapbacks.");
			const resolvedMessageId = messageId();
			const partIndex = readNumberParam(params, "partIndex", { integer: true });
			const resolvedChatGuid = await chatGuid();
			const reactionsToSend = remove && !reaction ? [...TAPBACK_KINDS] : reaction ? [reaction] : [];
			for (const kind of reactionsToSend) await runtime.sendReaction({
				chatGuid: resolvedChatGuid,
				messageId: resolvedMessageId,
				reaction: kind,
				remove: remove || void 0,
				partIndex: typeof partIndex === "number" ? partIndex : void 0,
				options: {
					...opts,
					chatGuid: resolvedChatGuid
				}
			});
			return jsonResult({
				ok: true,
				...remove ? { removed: true } : { added: reaction }
			});
		}
		if (action === "edit") {
			await assertPrivateApiEnabled();
			const resolvedMessageId = messageId({ requireFromMe: true });
			const text = readStringParam(params, "text") ?? readStringParam(params, "newText") ?? readStringParam(params, "message");
			if (!text) throw new Error("iMessage edit requires text, newText, or message.");
			const partIndex = readNumberParam(params, "partIndex", { integer: true });
			const backwardsCompatMessage = readStringParam(params, "backwardsCompatMessage");
			const resolvedChatGuid = await chatGuid();
			await runtime.editMessage({
				chatGuid: resolvedChatGuid,
				messageId: resolvedMessageId,
				text,
				backwardsCompatMessage: backwardsCompatMessage ?? void 0,
				partIndex: typeof partIndex === "number" ? partIndex : void 0,
				options: {
					...opts,
					chatGuid: resolvedChatGuid
				}
			});
			return jsonResult({
				ok: true,
				edited: resolvedMessageId
			});
		}
		if (action === "unsend") {
			await assertPrivateApiEnabled();
			const resolvedMessageId = messageId({ requireFromMe: true });
			const partIndex = readNumberParam(params, "partIndex", { integer: true });
			const resolvedChatGuid = await chatGuid();
			await runtime.unsendMessage({
				chatGuid: resolvedChatGuid,
				messageId: resolvedMessageId,
				partIndex: typeof partIndex === "number" ? partIndex : void 0,
				options: {
					...opts,
					chatGuid: resolvedChatGuid
				}
			});
			return jsonResult({
				ok: true,
				unsent: resolvedMessageId
			});
		}
		if (action === "reply") {
			await assertPrivateApiEnabled();
			const resolvedMessageId = messageId();
			const text = readMessageText(params);
			if (!text) throw new Error("iMessage reply requires text or message.");
			const attachment = extractReplyAttachment(params);
			if (attachment) {
				if (attachment.spec === null) throw new Error(`iMessage reply rejected \`${attachment.bypassParam}\` because it did not pass through the outbound media resolver. Pass a base64 \`buffer\` + \`filename\` directly, or invoke message(action: "reply") through the runner so the resolver can validate the path against mediaLocalRoots/sandbox/size before sending.`);
				if (privateApiStatus?.cliCapabilities?.sendRichSupportsAttachment !== true) throw new Error("iMessage reply with an attachment needs an imsg build that exposes `send-rich --file` (openclaw/imsg#114). Upgrade imsg, or use action 'upload-file' (with filePath/filename) or action 'send' (with media) to deliver the file plus a separate 'reply' for any text.");
			}
			const partIndex = readNumberParam(params, "partIndex", { integer: true });
			const resolvedChatGuid = await chatGuid();
			const result = await runtime.sendRichMessage({
				chatGuid: resolvedChatGuid,
				text,
				replyToMessageId: resolvedMessageId,
				partIndex: typeof partIndex === "number" ? partIndex : void 0,
				attachment: attachment?.spec ?? void 0,
				options: {
					...opts,
					chatGuid: resolvedChatGuid
				}
			});
			rememberOutboundBridgeMessage({
				accountId: account.accountId,
				messageId: result.messageId,
				chatGuid: resolvedChatGuid
			});
			return jsonResult({
				ok: true,
				messageId: result.messageId,
				repliedTo: resolvedMessageId
			});
		}
		if (action === "sendWithEffect") {
			await assertPrivateApiEnabled();
			const text = readMessageText(params);
			const effectId = effectIdFromParam(readStringParam(params, "effectId") ?? readStringParam(params, "effect"));
			if (!text || !effectId) throw new Error("iMessage sendWithEffect requires text/message and effect/effectId.");
			const resolvedChatGuid = await chatGuid();
			const result = await runtime.sendRichMessage({
				chatGuid: resolvedChatGuid,
				text,
				effectId,
				options: {
					...opts,
					chatGuid: resolvedChatGuid
				}
			});
			rememberOutboundBridgeMessage({
				accountId: account.accountId,
				messageId: result.messageId,
				chatGuid: resolvedChatGuid
			});
			return jsonResult({
				ok: true,
				messageId: result.messageId,
				effect: effectId
			});
		}
		if (action === "renameGroup") {
			await assertPrivateApiEnabled();
			const displayName = readStringParam(params, "displayName") ?? readStringParam(params, "name");
			if (!displayName) throw new Error("iMessage renameGroup requires displayName or name.");
			const resolvedChatGuid = await chatGuid();
			await runtime.renameGroup({
				chatGuid: resolvedChatGuid,
				displayName,
				options: {
					...opts,
					chatGuid: resolvedChatGuid
				}
			});
			return jsonResult({
				ok: true,
				renamed: resolvedChatGuid,
				displayName
			});
		}
		if (action === "setGroupIcon") {
			await assertPrivateApiEnabled();
			const filename = readStringParam(params, "filename") ?? readStringParam(params, "name") ?? "icon.png";
			const resolvedChatGuid = await chatGuid();
			await runtime.setGroupIcon({
				chatGuid: resolvedChatGuid,
				buffer: decodeBase64Buffer(params, action),
				filename,
				options: {
					...opts,
					chatGuid: resolvedChatGuid
				}
			});
			return jsonResult({
				ok: true,
				chatGuid: resolvedChatGuid,
				iconSet: true
			});
		}
		if (action === "addParticipant" || action === "removeParticipant") {
			await assertPrivateApiEnabled();
			const address = readStringParam(params, "address") ?? readStringParam(params, "participant");
			if (!address) throw new Error(`iMessage ${action} requires address or participant.`);
			const resolvedChatGuid = await chatGuid();
			if (action === "addParticipant") {
				await runtime.addParticipant({
					chatGuid: resolvedChatGuid,
					address,
					options: {
						...opts,
						chatGuid: resolvedChatGuid
					}
				});
				return jsonResult({
					ok: true,
					added: address,
					chatGuid: resolvedChatGuid
				});
			}
			await runtime.removeParticipant({
				chatGuid: resolvedChatGuid,
				address,
				options: {
					...opts,
					chatGuid: resolvedChatGuid
				}
			});
			return jsonResult({
				ok: true,
				removed: address,
				chatGuid: resolvedChatGuid
			});
		}
		if (action === "leaveGroup") {
			await assertPrivateApiEnabled();
			const resolvedChatGuid = await chatGuid();
			await runtime.leaveGroup({
				chatGuid: resolvedChatGuid,
				options: {
					...opts,
					chatGuid: resolvedChatGuid
				}
			});
			return jsonResult({
				ok: true,
				left: resolvedChatGuid
			});
		}
		if (action === "sendAttachment" || action === "upload-file") {
			await assertPrivateApiEnabled();
			const filename = readStringParam(params, "filename", { required: true });
			const asVoice = readBooleanParam(params, "asVoice") ?? readBooleanParam(params, "as_voice");
			const resolvedChatGuid = await chatGuid();
			const result = await runtime.sendAttachment({
				chatGuid: resolvedChatGuid,
				buffer: decodeBase64Buffer(params, action),
				filename,
				asVoice: asVoice ?? void 0,
				options: {
					...opts,
					chatGuid: resolvedChatGuid
				}
			});
			rememberOutboundBridgeMessage({
				accountId: account.accountId,
				messageId: result.messageId,
				chatGuid: resolvedChatGuid
			});
			return jsonResult({
				ok: true,
				messageId: result.messageId
			});
		}
		throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
	}
};
//#endregion
//#region extensions/imessage/src/group-policy.ts
function resolveIMessageGroupRequireMention(params) {
	return resolveChannelGroupRequireMention({
		cfg: params.cfg,
		channel: "imessage",
		groupId: params.groupId,
		accountId: params.accountId
	});
}
function resolveIMessageGroupToolPolicy(params) {
	return resolveChannelGroupToolsPolicy({
		cfg: params.cfg,
		channel: "imessage",
		groupId: params.groupId,
		accountId: params.accountId,
		senderId: params.senderId,
		senderName: params.senderName,
		senderUsername: params.senderUsername,
		senderE164: params.senderE164
	});
}
//#endregion
export { resolveIMessageGroupToolPolicy as n, imessageMessageActions as r, resolveIMessageGroupRequireMention as t };
