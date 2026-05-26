import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { s as statRegularFileSync } from "./regular-file-DaVeNX32.js";
import { p as resolvePayloadMediaUrls, v as sendPayloadMediaSequenceAndFinalize, x as sendTextMediaPayload } from "./reply-payload-DMPQsrQC.js";
import { c as normalizeInteractiveReply, f as renderMessagePresentationFallbackText, l as normalizeMessagePresentation, o as interactiveReplyToPresentation, p as resolveInteractiveTextFallback } from "./payload-BDV15CYA.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as chunkTextForOutbound } from "./text-chunking-C154U6-i.js";
import "./security-runtime-CcSekjBd.js";
import { i as createAttachedChannelResultAdapter, t as attachChannelToResult } from "./channel-send-result-swFdRKhg.js";
import { l as resolveFeishuRuntimeAccount, s as resolveFeishuAccount, x as parseFeishuCommentTarget } from "./accounts-Djfj3q-S.js";
import { s as createFeishuCardInteractionEnvelope } from "./send-result-D6azRnOt.js";
import { n as listFeishuDirectoryPeers, t as listFeishuDirectoryGroups } from "./directory.static-D6j7UthR.js";
import { r as createFeishuClient } from "./client-Cl7PkrEA.js";
import { c as getChatInfo, l as getChatMembers, r as cleanupAmbientCommentTypingReaction, t as deliverCommentThreadText, u as getFeishuMemberInfo } from "./drive-DsfKGzVF.js";
import "./runtime-api-DlkHVLk_.js";
import { a as sendCardFeishu, c as sendStructuredCardFeishu, g as shouldSuppressFeishuTextForVoiceMedia, h as sendMediaFeishu, i as resolveFeishuCardTemplate, n as getMessageFeishu, o as sendMarkdownCardFeishu, s as sendMessageFeishu, t as editMessageFeishu } from "./send-3_y4wvO8.js";
import { n as probeFeishu } from "./probe-BLDzpuzR.js";
import path from "node:path";
//#region extensions/feishu/src/directory.ts
async function listFeishuDirectoryPeersLive(params) {
	const account = resolveFeishuAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) return listFeishuDirectoryPeers(params);
	try {
		const client = createFeishuClient(account);
		const peers = [];
		const limit = params.limit ?? 50;
		const response = await client.contact.user.list({ params: { page_size: Math.min(limit, 50) } });
		if (response.code !== 0) throw new Error(response.msg || `code ${response.code}`);
		const q = normalizeLowercaseStringOrEmpty(params.query);
		for (const user of response.data?.items ?? []) {
			if (user.open_id) {
				const name = user.name || "";
				if (!q || normalizeLowercaseStringOrEmpty(user.open_id).includes(q) || normalizeLowercaseStringOrEmpty(name).includes(q)) peers.push({
					kind: "user",
					id: user.open_id,
					name: name || void 0
				});
			}
			if (peers.length >= limit) break;
		}
		return peers;
	} catch (err) {
		if (params.fallbackToStatic === false) throw err instanceof Error ? err : /* @__PURE__ */ new Error("Feishu live peer lookup failed");
		return listFeishuDirectoryPeers(params);
	}
}
async function listFeishuDirectoryGroupsLive(params) {
	const account = resolveFeishuAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) return listFeishuDirectoryGroups(params);
	try {
		const client = createFeishuClient(account);
		const groups = [];
		const limit = params.limit ?? 50;
		const response = await client.im.chat.list({ params: { page_size: Math.min(limit, 100) } });
		if (response.code !== 0) throw new Error(response.msg || `code ${response.code}`);
		const q = normalizeLowercaseStringOrEmpty(params.query);
		for (const chat of response.data?.items ?? []) {
			if (chat.chat_id) {
				const name = chat.name || "";
				if (!q || normalizeLowercaseStringOrEmpty(chat.chat_id).includes(q) || normalizeLowercaseStringOrEmpty(name).includes(q)) groups.push({
					kind: "group",
					id: chat.chat_id,
					name: name || void 0
				});
			}
			if (groups.length >= limit) break;
		}
		return groups;
	} catch (err) {
		if (params.fallbackToStatic === false) throw err instanceof Error ? err : /* @__PURE__ */ new Error("Feishu live group lookup failed");
		return listFeishuDirectoryGroups(params);
	}
}
//#endregion
//#region extensions/feishu/src/outbound.ts
const RENDERED_FEISHU_CARD = Symbol("openclaw.renderedFeishuCard");
function normalizePossibleLocalImagePath(text) {
	const raw = text?.trim();
	if (!raw) return null;
	if (/\s/.test(raw)) return null;
	if (/^(https?:\/\/|data:|file:\/\/)/i.test(raw)) return null;
	const ext = normalizeLowercaseStringOrEmpty(path.extname(raw));
	if (![
		".jpg",
		".jpeg",
		".png",
		".gif",
		".webp",
		".bmp",
		".ico",
		".tiff"
	].includes(ext)) return null;
	if (!path.isAbsolute(raw)) return null;
	try {
		if (statRegularFileSync(raw).missing) return null;
	} catch {
		return null;
	}
	return raw;
}
function shouldUseCard(text) {
	return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function escapeFeishuCardMarkdownText(text) {
	return text.replace(/[&<>]/g, (char) => {
		switch (char) {
			case "&": return "&amp;";
			case "<": return "&lt;";
			case ">": return "&gt;";
			default: return char;
		}
	});
}
function resolveSafeFeishuButtonUrl(url) {
	const trimmed = url?.trim();
	if (!trimmed) return;
	try {
		const parsed = new URL(trimmed);
		return parsed.protocol === "https:" || parsed.protocol === "http:" ? trimmed : void 0;
	} catch {
		return;
	}
}
function markRenderedFeishuCard(card) {
	Object.defineProperty(card, RENDERED_FEISHU_CARD, {
		value: true,
		enumerable: false
	});
	return card;
}
function sanitizeNativeFeishuCardButton(button) {
	if (!isRecord(button)) return;
	const text = isRecord(button.text) && typeof button.text.content === "string" ? button.text.content : void 0;
	if (!text?.trim()) return;
	const style = button.type === "danger" ? "danger" : button.type === "primary" ? "primary" : void 0;
	const rendered = {
		tag: "button",
		text: {
			tag: "plain_text",
			content: text
		},
		type: mapFeishuButtonType(style)
	};
	const safeUrl = resolveSafeFeishuButtonUrl(typeof button.url === "string" ? button.url : void 0);
	if (safeUrl) rendered.url = safeUrl;
	if (isRecord(button.value) && button.value.oc === "ocf1") rendered.value = button.value;
	return rendered.url || rendered.value ? rendered : void 0;
}
function sanitizeNativeFeishuCardElement(element) {
	if (!isRecord(element) || typeof element.tag !== "string") return;
	if (element.tag === "hr") return { tag: "hr" };
	if (element.tag === "markdown" && typeof element.content === "string") return {
		tag: "markdown",
		content: escapeFeishuCardMarkdownText(element.content)
	};
	if (element.tag === "action" && Array.isArray(element.actions)) {
		const actions = element.actions.map((action) => sanitizeNativeFeishuCardButton(action)).filter((action) => Boolean(action));
		return actions.length > 0 ? {
			tag: "action",
			actions
		} : void 0;
	}
}
function sanitizeNativeFeishuCard(card) {
	const body = isRecord(card.body) ? card.body : void 0;
	const elements = (Array.isArray(body?.elements) ? body.elements : []).map((element) => sanitizeNativeFeishuCardElement(element)).filter((element) => Boolean(element));
	if (elements.length === 0) return;
	const header = isRecord(card.header) ? card.header : void 0;
	const title = isRecord(header?.title) && typeof header.title.content === "string" ? header.title.content : void 0;
	return markRenderedFeishuCard({
		schema: "2.0",
		config: { width_mode: "fill" },
		...title?.trim() ? { header: {
			title: {
				tag: "plain_text",
				content: title
			},
			template: resolveFeishuCardTemplate(typeof header?.template === "string" ? header.template : void 0) ?? "blue"
		} } : {},
		body: { elements }
	});
}
function readNativeFeishuCard(payload) {
	const feishuData = payload.channelData?.feishu;
	if (!isRecord(feishuData)) return;
	const card = feishuData.card ?? feishuData.interactiveCard;
	if (!isRecord(card)) return;
	if (card[RENDERED_FEISHU_CARD] === true) return card;
	return sanitizeNativeFeishuCard(card);
}
function mapFeishuButtonType(style) {
	if (style === "primary" || style === "success") return "primary";
	if (style === "danger") return "danger";
	return "default";
}
function buildFeishuPayloadButton(button) {
	const rendered = {
		tag: "button",
		text: {
			tag: "plain_text",
			content: button.label
		},
		type: mapFeishuButtonType(button.style)
	};
	if (button.url) {
		const safeUrl = resolveSafeFeishuButtonUrl(button.url);
		if (safeUrl) rendered.url = safeUrl;
	}
	if (button.value) rendered.value = createFeishuCardInteractionEnvelope({
		k: "quick",
		a: "feishu.payload.button",
		q: button.value
	});
	return rendered.url || rendered.value ? rendered : void 0;
}
function buildFeishuCardElementForBlock(block) {
	if (block.type === "text") return {
		tag: "markdown",
		content: escapeFeishuCardMarkdownText(block.text)
	};
	if (block.type === "context") return {
		tag: "markdown",
		content: `<font color='grey'>${escapeFeishuCardMarkdownText(block.text)}</font>`
	};
	if (block.type === "divider") return { tag: "hr" };
	if (block.type === "buttons") {
		const actions = block.buttons.map((button) => buildFeishuPayloadButton(button)).filter((button) => Boolean(button));
		if (actions.length === 0) return;
		return {
			tag: "action",
			actions
		};
	}
	const labels = block.options.map((option) => `- ${option.label}`).join("\n");
	return {
		tag: "markdown",
		content: `${escapeFeishuCardMarkdownText(block.placeholder?.trim() || "Options")}:\n${escapeFeishuCardMarkdownText(labels)}`
	};
}
function buildFeishuPayloadCard(params) {
	const nativeCard = readNativeFeishuCard(params.payload);
	if (nativeCard) return nativeCard;
	const interactive = normalizeInteractiveReply(params.payload.interactive);
	const presentation = normalizeMessagePresentation(params.payload.presentation) ?? (interactive ? interactiveReplyToPresentation(interactive) : void 0);
	if (!presentation && !interactive) return;
	const text = resolveInteractiveTextFallback({
		text: params.text ?? params.payload.text,
		interactive
	});
	const elements = [];
	if (text?.trim()) elements.push({
		tag: "markdown",
		content: escapeFeishuCardMarkdownText(text)
	});
	for (const block of presentation?.blocks ?? []) {
		const element = buildFeishuCardElementForBlock(block);
		if (element) elements.push(element);
	}
	if (elements.length === 0) elements.push({
		tag: "markdown",
		content: renderMessagePresentationFallbackText({
			text,
			presentation
		})
	});
	const identityTitle = params.identity ? params.identity.emoji ? `${params.identity.emoji} ${params.identity.name ?? ""}`.trim() : params.identity.name ?? "" : "";
	const title = presentation?.title ?? identityTitle;
	const template = resolveFeishuCardTemplate(presentation?.tone === "danger" ? "red" : presentation?.tone === "warning" ? "orange" : presentation?.tone === "success" ? "green" : "blue");
	return markRenderedFeishuCard({
		schema: "2.0",
		config: { width_mode: "fill" },
		...title ? { header: {
			title: {
				tag: "plain_text",
				content: title
			},
			template: template ?? "blue"
		} } : {},
		body: { elements }
	});
}
function renderFeishuPresentationPayload({ payload, presentation, ctx }) {
	const card = buildFeishuPayloadCard({
		payload,
		text: payload.text,
		identity: ctx.identity
	});
	if (!card) return null;
	const existingFeishuData = isRecord(payload.channelData?.feishu) ? payload.channelData.feishu : void 0;
	return {
		...payload,
		text: renderMessagePresentationFallbackText({
			text: payload.text,
			presentation
		}),
		channelData: {
			...payload.channelData,
			feishu: {
				...existingFeishuData,
				card
			}
		}
	};
}
function resolveReplyToMessageId(params) {
	const replyToId = params.replyToId?.trim();
	if (replyToId) return replyToId;
	if (params.threadId == null) return;
	return String(params.threadId).trim() || void 0;
}
function resolveFeishuMediaReplyMode(params) {
	const trimmedReplyToId = params.replyToId?.trim() || void 0;
	return {
		replyToMessageId: resolveReplyToMessageId(params),
		replyInThread: params.threadId != null && !trimmedReplyToId
	};
}
async function sendCommentThreadReply(params) {
	const target = parseFeishuCommentTarget(params.to);
	if (!target) return null;
	const client = createFeishuClient(resolveFeishuAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}));
	const replyId = params.replyId?.trim();
	try {
		const result = await deliverCommentThreadText(client, {
			file_token: target.fileToken,
			file_type: target.fileType,
			comment_id: target.commentId,
			content: params.text
		});
		return {
			messageId: typeof result.reply_id === "string" && result.reply_id || typeof result.comment_id === "string" && result.comment_id || "",
			chatId: target.commentId,
			result
		};
	} finally {
		if (replyId) cleanupAmbientCommentTypingReaction({
			client,
			deliveryContext: {
				channel: "feishu",
				to: params.to,
				threadId: replyId
			}
		});
	}
}
async function sendOutboundText(params) {
	const { cfg, to, text, accountId, replyToMessageId, replyInThread } = params;
	const commentResult = await sendCommentThreadReply({
		cfg,
		to,
		text,
		replyId: replyToMessageId,
		accountId
	});
	if (commentResult) return commentResult;
	const renderMode = resolveFeishuAccount({
		cfg,
		accountId
	}).config?.renderMode ?? "auto";
	if (renderMode === "card" || renderMode === "auto" && shouldUseCard(text)) return sendMarkdownCardFeishu({
		cfg,
		to,
		text,
		accountId,
		replyToMessageId,
		replyInThread
	});
	return sendMessageFeishu({
		cfg,
		to,
		text,
		accountId,
		replyToMessageId,
		replyInThread
	});
}
const feishuOutbound = {
	deliveryMode: "direct",
	chunker: chunkTextForOutbound,
	chunkerMode: "markdown",
	textChunkLimit: 4e3,
	presentationCapabilities: {
		supported: true,
		buttons: true,
		selects: false,
		context: true,
		divider: true,
		limits: {
			actions: {
				maxActions: 20,
				maxActionsPerRow: 5,
				maxLabelLength: 40,
				maxValueBytes: 1024
			},
			text: {
				maxLength: 4e3,
				encoding: "characters",
				markdownDialect: "markdown"
			}
		}
	},
	renderPresentation: renderFeishuPresentationPayload,
	sendPayload: async (ctx) => {
		const card = buildFeishuPayloadCard({
			payload: ctx.payload,
			text: ctx.text,
			identity: ctx.identity
		});
		if (!card) return await sendTextMediaPayload({
			channel: "feishu",
			ctx,
			adapter: feishuOutbound
		});
		const replyToMessageId = resolveReplyToMessageId({
			replyToId: ctx.replyToId,
			threadId: ctx.threadId
		});
		if (parseFeishuCommentTarget(ctx.to)) return await sendTextMediaPayload({
			channel: "feishu",
			ctx: {
				...ctx,
				payload: {
					...ctx.payload,
					text: renderMessagePresentationFallbackText({
						text: ctx.payload.text,
						presentation: normalizeMessagePresentation(ctx.payload.presentation) ?? (() => {
							const interactive = normalizeInteractiveReply(ctx.payload.interactive);
							return interactive ? interactiveReplyToPresentation(interactive) : void 0;
						})()
					}),
					interactive: void 0,
					presentation: void 0,
					channelData: void 0
				}
			},
			adapter: feishuOutbound
		});
		const mediaUrls = resolvePayloadMediaUrls(ctx.payload).map((entry) => entry.trim()).filter(Boolean);
		return attachChannelToResult("feishu", await sendPayloadMediaSequenceAndFinalize({
			text: ctx.payload.text ?? "",
			mediaUrls,
			send: async ({ mediaUrl }) => await sendMediaFeishu({
				cfg: ctx.cfg,
				to: ctx.to,
				mediaUrl,
				accountId: ctx.accountId ?? void 0,
				mediaLocalRoots: ctx.mediaLocalRoots,
				replyToMessageId,
				...ctx.payload.audioAsVoice === true || ctx.audioAsVoice === true ? { audioAsVoice: true } : {}
			}),
			finalize: async () => await sendCardFeishu({
				cfg: ctx.cfg,
				to: ctx.to,
				card,
				replyToMessageId,
				replyInThread: ctx.threadId != null && !ctx.replyToId,
				accountId: ctx.accountId ?? void 0
			})
		}));
	},
	...createAttachedChannelResultAdapter({
		channel: "feishu",
		sendText: async ({ cfg, to, text, accountId, replyToId, threadId, mediaLocalRoots, identity }) => {
			const { replyToMessageId, replyInThread } = resolveFeishuMediaReplyMode({
				replyToId,
				threadId
			});
			const localImagePath = normalizePossibleLocalImagePath(text);
			if (localImagePath) try {
				return await sendMediaFeishu({
					cfg,
					to,
					mediaUrl: localImagePath,
					accountId: accountId ?? void 0,
					replyToMessageId,
					replyInThread,
					mediaLocalRoots
				});
			} catch (err) {
				console.error(`[feishu] local image path auto-send failed:`, err);
			}
			if (parseFeishuCommentTarget(to)) return await sendOutboundText({
				cfg,
				to,
				text,
				accountId: accountId ?? void 0,
				replyToMessageId,
				replyInThread
			});
			const renderMode = resolveFeishuAccount({
				cfg,
				accountId: accountId ?? void 0
			}).config?.renderMode ?? "auto";
			if (renderMode === "card" || renderMode === "auto" && shouldUseCard(text)) {
				const header = identity ? {
					title: identity.emoji ? `${identity.emoji} ${identity.name ?? ""}`.trim() : identity.name ?? "",
					template: "blue"
				} : void 0;
				return await sendStructuredCardFeishu({
					cfg,
					to,
					text,
					replyToMessageId,
					replyInThread,
					accountId: accountId ?? void 0,
					header: header?.title ? header : void 0
				});
			}
			return await sendOutboundText({
				cfg,
				to,
				text,
				accountId: accountId ?? void 0,
				replyToMessageId,
				replyInThread
			});
		},
		sendMedia: async ({ cfg, to, text, mediaUrl, audioAsVoice, accountId, mediaLocalRoots, replyToId, threadId }) => {
			const { replyToMessageId, replyInThread } = resolveFeishuMediaReplyMode({
				replyToId,
				threadId
			});
			if (parseFeishuCommentTarget(to)) return await sendOutboundText({
				cfg,
				to,
				text: [text?.trim(), mediaUrl?.trim()].filter(Boolean).join("\n\n") || mediaUrl || text || "",
				accountId: accountId ?? void 0,
				replyToMessageId,
				replyInThread
			});
			const suppressTextForVoiceMedia = mediaUrl !== void 0 && shouldSuppressFeishuTextForVoiceMedia({
				mediaUrl,
				audioAsVoice
			});
			if (text?.trim() && !suppressTextForVoiceMedia) await sendOutboundText({
				cfg,
				to,
				text,
				accountId: accountId ?? void 0,
				replyToMessageId,
				replyInThread
			});
			if (mediaUrl) try {
				const result = await sendMediaFeishu({
					cfg,
					to,
					mediaUrl,
					accountId: accountId ?? void 0,
					mediaLocalRoots,
					replyToMessageId,
					replyInThread,
					...audioAsVoice === true ? { audioAsVoice: true } : {}
				});
				if (result.voiceIntentDegradedToFile && text?.trim()) await sendOutboundText({
					cfg,
					to,
					text,
					accountId: accountId ?? void 0,
					replyToMessageId,
					replyInThread
				});
				return result;
			} catch (err) {
				console.error(`[feishu] sendMediaFeishu failed:`, err);
				return await sendOutboundText({
					cfg,
					to,
					text: [text?.trim(), `📎 ${mediaUrl}`].filter(Boolean).join("\n\n"),
					accountId: accountId ?? void 0,
					replyToMessageId,
					replyInThread
				});
			}
			return await sendOutboundText({
				cfg,
				to,
				text: text ?? "",
				accountId: accountId ?? void 0,
				replyToMessageId,
				replyInThread
			});
		}
	})
};
//#endregion
//#region extensions/feishu/src/pins.ts
function assertFeishuPinApiSuccess(response, action) {
	if (response.code !== 0) throw new Error(`Feishu ${action} failed: ${response.msg || `code ${response.code}`}`);
}
function normalizePin(pin) {
	return {
		messageId: pin.message_id,
		chatId: pin.chat_id,
		operatorId: pin.operator_id,
		operatorIdType: pin.operator_id_type,
		createTime: pin.create_time
	};
}
async function createPinFeishu(params) {
	const account = resolveFeishuRuntimeAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	const response = await createFeishuClient(account).im.pin.create({ data: { message_id: params.messageId } });
	assertFeishuPinApiSuccess(response, "pin create");
	return response.data?.pin ? normalizePin(response.data.pin) : null;
}
async function removePinFeishu(params) {
	const account = resolveFeishuRuntimeAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	assertFeishuPinApiSuccess(await createFeishuClient(account).im.pin.delete({ path: { message_id: params.messageId } }), "pin delete");
}
async function listPinsFeishu(params) {
	const account = resolveFeishuRuntimeAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	const response = await createFeishuClient(account).im.pin.list({ params: {
		chat_id: params.chatId,
		...params.startTime ? { start_time: params.startTime } : {},
		...params.endTime ? { end_time: params.endTime } : {},
		...typeof params.pageSize === "number" ? { page_size: Math.max(1, Math.min(100, Math.floor(params.pageSize))) } : {},
		...params.pageToken ? { page_token: params.pageToken } : {}
	} });
	assertFeishuPinApiSuccess(response, "pin list");
	return {
		chatId: params.chatId,
		pins: (response.data?.items ?? []).map(normalizePin),
		hasMore: response.data?.has_more === true,
		pageToken: response.data?.page_token
	};
}
//#endregion
//#region extensions/feishu/src/reactions.ts
function resolveConfiguredFeishuClient(params) {
	const account = resolveFeishuRuntimeAccount(params);
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	return createFeishuClient(account);
}
function assertFeishuReactionApiSuccess(response, action) {
	if (response.code !== 0) throw new Error(`Feishu ${action} failed: ${response.msg || `code ${response.code}`}`);
}
/**
* Add a reaction (emoji) to a message.
* @param emojiType - Feishu emoji type, e.g., "SMILE", "THUMBSUP", "HEART"
* @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
*/
async function addReactionFeishu(params) {
	const { cfg, messageId, emojiType, accountId } = params;
	const response = await resolveConfiguredFeishuClient({
		cfg,
		accountId
	}).im.messageReaction.create({
		path: { message_id: messageId },
		data: { reaction_type: { emoji_type: emojiType } }
	});
	assertFeishuReactionApiSuccess(response, "add reaction");
	const reactionId = response.data?.reaction_id;
	if (!reactionId) throw new Error("Feishu add reaction failed: no reaction_id returned");
	return { reactionId };
}
/**
* Remove a reaction from a message.
*/
async function removeReactionFeishu(params) {
	const { cfg, messageId, reactionId, accountId } = params;
	assertFeishuReactionApiSuccess(await resolveConfiguredFeishuClient({
		cfg,
		accountId
	}).im.messageReaction.delete({ path: {
		message_id: messageId,
		reaction_id: reactionId
	} }), "remove reaction");
}
/**
* List all reactions for a message.
*/
async function listReactionsFeishu(params) {
	const { cfg, messageId, emojiType, accountId } = params;
	const response = await resolveConfiguredFeishuClient({
		cfg,
		accountId
	}).im.messageReaction.list({
		path: { message_id: messageId },
		params: emojiType ? { reaction_type: emojiType } : void 0
	});
	assertFeishuReactionApiSuccess(response, "list reactions");
	return (response.data?.items ?? []).map((item) => ({
		reactionId: item.reaction_id ?? "",
		emojiType: item.reaction_type?.emoji_type ?? "",
		operatorType: item.operator_type === "app" ? "app" : "user",
		operatorId: item.operator_id?.open_id ?? item.operator_id?.user_id ?? item.operator_id?.union_id ?? ""
	}));
}
//#endregion
//#region extensions/feishu/src/channel.runtime.ts
const feishuChannelRuntime = {
	listFeishuDirectoryGroupsLive,
	listFeishuDirectoryPeersLive,
	feishuOutbound: { ...feishuOutbound },
	createPinFeishu,
	listPinsFeishu,
	removePinFeishu,
	probeFeishu,
	addReactionFeishu,
	listReactionsFeishu,
	removeReactionFeishu,
	getChatInfo,
	getChatMembers,
	getFeishuMemberInfo,
	editMessageFeishu,
	getMessageFeishu,
	sendCardFeishu,
	sendMessageFeishu
};
//#endregion
export { feishuChannelRuntime };
