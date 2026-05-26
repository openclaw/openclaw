import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { t as createNonExitingRuntime } from "./runtime-yzlkhCoS.js";
import { a as shouldLogVerbose, r as logVerbose, t as danger } from "./globals-YU5FjfZK.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { n as normalizePluginHttpPath } from "./http-route-overlap-BShPdT8Q.js";
import { m as resolveSendableOutboundReplyParts } from "./reply-payload-DMPQsrQC.js";
import { a as resolveInboundLastRouteSessionKey, i as resolveAgentRoute } from "./resolve-route-C8IahAyG.js";
import { n as firstDefined } from "./allow-from-D1f7S_rf.js";
import { a as readChannelAllowFromStore, d as upsertChannelPairingRequest } from "./pairing-store-jPMfFWFn.js";
import { o as resolveStableChannelMessageIngress } from "./runtime-BUVuto5K.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "./runtime-group-policy-CmZDlIwd.js";
import { l as resolvePinnedMainDmOwnerFromAllowlist } from "./dm-policy-shared-CXEKnzKD.js";
import { f as saveMediaStream } from "./store-rQFzzX5P.js";
import { r as chunkMarkdownText } from "./chunk-IIklKK4Y.js";
import { n as buildMentionRegexes, r as matchesMentionPatterns } from "./mentions-DmNrCnsQ.js";
import { t as finalizeInboundContext } from "./inbound-context-Cg0uCtqQ.js";
import { t as waitForAbortSignal } from "./abort-signal-B53kbSiw.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./routing-79DRZvfm.js";
import { i as shouldComputeCommandAuthorized } from "./command-detection-CC0FOFv2.js";
import { r as formatInboundEnvelope } from "./envelope-DUI2KFD9.js";
import "./history-BD_TtuvO.js";
import { n as hasFinalChannelTurnDispatch } from "./dispatch-result-BM3RYtx4.js";
import { t as createChannelHistoryWindow } from "./history-window-Gy0CzEef.js";
import { n as recordChannelActivity } from "./channel-activity-eMQlJ3BE.js";
import "./reply-history-Dd_Mx-HZ.js";
import "./reply-runtime-DbNBMCwV.js";
import "./reply-dispatch-runtime-Brv61pKL.js";
import { a as isRequestBodyLimitError, c as requestBodyErrorToText, s as readRequestBodyWithLimit } from "./http-body-BfDL157U.js";
import "./runtime-config-snapshot-BBsNBtE3.js";
import "./media-store-3-Nw2YTP.js";
import { n as resolveConfiguredBindingRoute, r as resolveRuntimeConversationBindingRoute, t as ensureConfiguredBindingRouteReady } from "./binding-routing-DfoE5KF_.js";
import "./conversation-runtime-guwDSNIo.js";
import { t as resolvePairingIdLabel } from "./pairing-labels-D7SOe44q.js";
import "./command-auth-native-BhcKSceK.js";
import { a as resolveInboundSessionEnvelopeContext } from "./channel-inbound-C7GtKjtG.js";
import { n as toLocationContext, t as formatLocationText } from "./location-B0jdizlz.js";
import "./channel-ingress-runtime-C3bbz3sX.js";
import { h as createMessageReceiveContext } from "./channel-message-DMGbyII_.js";
import { t as createChannelPairingChallengeIssuer } from "./channel-pairing-N4dBc-K-.js";
import { t as createClaimableDedupe } from "./persistent-dedupe-DaB2erKZ.js";
import "./webhook-ingress-R0qMwT4u.js";
import { a as createWebhookInFlightLimiter, i as beginWebhookRequestPipelineOrReject } from "./webhook-request-guards-iMi786D5.js";
import { i as resolveSingleWebhookTarget, n as registerWebhookTargetWithPluginRoute } from "./webhook-targets-gc0zD_lY.js";
import { i as resolveLineAccount, r as resolveDefaultLineAccountId } from "./accounts-B7VHf02h.js";
import { a as resolveLineGroupConfigEntry, n as getLineRuntime, t as buildLineQuickReplyFallbackText } from "./quick-reply-fallback-DMrFXvWi.js";
import { D as showLoadingAnimation, S as pushMessagesLine, T as replyMessageLine, c as processLineMessage, d as createImageMessage, f as createLocationMessage, g as getUserDisplayName, k as buildTemplateMessageFromPayload, m as createTextMessageWithQuickReplies, p as createQuickReplyItems, u as createFlexMessage, w as pushTextMessageWithQuickReplies, x as pushMessageLine } from "./markdown-to-line-DNDQuzS1.js";
import { i as mergeHeaders, n as HTTPFetchClient, r as convertResponseToReadable } from "./messagingApiClient-CLvV39gg.js";
import crypto from "node:crypto";
//#region extensions/line/src/bot-access.ts
function normalizeLineAllowEntry(value) {
	const trimmed = String(value).trim();
	if (!trimmed) return "";
	if (trimmed === "*") return "*";
	return trimmed.replace(/^line:(?:user:)?/i, "");
}
const normalizeAllowFrom = (list) => {
	const entries = (list ?? []).map((value) => normalizeLineAllowEntry(value)).filter(Boolean);
	return {
		entries,
		hasWildcard: entries.includes("*"),
		hasEntries: entries.length > 0
	};
};
//#endregion
//#region node_modules/@line/bot-sdk/dist/messaging-api/api/messagingApiBlobClient.js
/**
* LINE Messaging API
* This document describes LINE Messaging API.
*
* The version of the OpenAPI document: 0.0.1
*
*
* NOTE: This class is auto generated by OpenAPI Generator (https://openapi-generator.tech).
* https://openapi-generator.tech
* Do not edit the class manually.
*/
/**
* @see {@link LineBotClient} for a unified interface that wraps this client.
*/
var MessagingApiBlobClient = class {
	httpClient;
	constructor(config) {
		const baseURL = config.baseURL || "https://api-data.line.me";
		const defaultHeaders = mergeHeaders(config.defaultHeaders, { Authorization: "Bearer " + config.channelAccessToken });
		this.httpClient = new HTTPFetchClient({
			defaultHeaders,
			baseURL
		});
	}
	/**
	* Download image, video, and audio data sent from users.
	* @param messageId Message ID of video or audio
	*
	* @see <a href="https://developers.line.biz/en/reference/messaging-api/#get-content"> Documentation</a>
	*/
	async getMessageContent(messageId) {
		return (await this.getMessageContentWithHttpInfo(messageId)).body;
	}
	/**
	* Download image, video, and audio data sent from users..
	* This method includes HttpInfo object to return additional information.
	* @param messageId Message ID of video or audio
	*
	* @see <a href="https://developers.line.biz/en/reference/messaging-api/#get-content"> Documentation</a>
	*/
	async getMessageContentWithHttpInfo(messageId) {
		const response = await this.httpClient.get("/v2/bot/message/{messageId}/content".replace("{messageId}", String(messageId)));
		return {
			httpResponse: response,
			body: convertResponseToReadable(response)
		};
	}
	/**
	* Get a preview image of the image or video
	* @param messageId Message ID of image or video
	*
	* @see <a href="https://developers.line.biz/en/reference/messaging-api/#get-image-or-video-preview"> Documentation</a>
	*/
	async getMessageContentPreview(messageId) {
		return (await this.getMessageContentPreviewWithHttpInfo(messageId)).body;
	}
	/**
	* Get a preview image of the image or video.
	* This method includes HttpInfo object to return additional information.
	* @param messageId Message ID of image or video
	*
	* @see <a href="https://developers.line.biz/en/reference/messaging-api/#get-image-or-video-preview"> Documentation</a>
	*/
	async getMessageContentPreviewWithHttpInfo(messageId) {
		const response = await this.httpClient.get("/v2/bot/message/{messageId}/content/preview".replace("{messageId}", String(messageId)));
		return {
			httpResponse: response,
			body: convertResponseToReadable(response)
		};
	}
	/**
	* Verify the preparation status of a video or audio for getting
	* @param messageId Message ID of video or audio
	*
	* @see <a href="https://developers.line.biz/en/reference/messaging-api/#verify-video-or-audio-preparation-status"> Documentation</a>
	*/
	async getMessageContentTranscodingByMessageId(messageId) {
		return (await this.getMessageContentTranscodingByMessageIdWithHttpInfo(messageId)).body;
	}
	/**
	* Verify the preparation status of a video or audio for getting.
	* This method includes HttpInfo object to return additional information.
	* @param messageId Message ID of video or audio
	*
	* @see <a href="https://developers.line.biz/en/reference/messaging-api/#verify-video-or-audio-preparation-status"> Documentation</a>
	*/
	async getMessageContentTranscodingByMessageIdWithHttpInfo(messageId) {
		const res = await this.httpClient.get("/v2/bot/message/{messageId}/content/transcoding".replace("{messageId}", String(messageId)));
		const text = await res.text();
		return {
			httpResponse: res,
			body: text ? JSON.parse(text) : null
		};
	}
	/**
	* Download rich menu image.
	* @param richMenuId ID of the rich menu with the image to be downloaded
	*
	* @see <a href="https://developers.line.biz/en/reference/messaging-api/#download-rich-menu-image"> Documentation</a>
	*/
	async getRichMenuImage(richMenuId) {
		return (await this.getRichMenuImageWithHttpInfo(richMenuId)).body;
	}
	/**
	* Download rich menu image..
	* This method includes HttpInfo object to return additional information.
	* @param richMenuId ID of the rich menu with the image to be downloaded
	*
	* @see <a href="https://developers.line.biz/en/reference/messaging-api/#download-rich-menu-image"> Documentation</a>
	*/
	async getRichMenuImageWithHttpInfo(richMenuId) {
		const response = await this.httpClient.get("/v2/bot/richmenu/{richMenuId}/content".replace("{richMenuId}", String(richMenuId)));
		return {
			httpResponse: response,
			body: convertResponseToReadable(response)
		};
	}
	/**
	* Upload rich menu image
	* @param richMenuId The ID of the rich menu to attach the image to
	* @param body
	*
	* @see <a href="https://developers.line.biz/en/reference/messaging-api/#upload-rich-menu-image"> Documentation</a>
	*/
	async setRichMenuImage(richMenuId, body) {
		return (await this.setRichMenuImageWithHttpInfo(richMenuId, body)).body;
	}
	/**
	* Upload rich menu image.
	* This method includes HttpInfo object to return additional information.
	* @param richMenuId The ID of the rich menu to attach the image to
	* @param body
	*
	* @see <a href="https://developers.line.biz/en/reference/messaging-api/#upload-rich-menu-image"> Documentation</a>
	*/
	async setRichMenuImageWithHttpInfo(richMenuId, body) {
		const params = body;
		const res = await this.httpClient.postBinaryContent("/v2/bot/richmenu/{richMenuId}/content".replace("{richMenuId}", String(richMenuId)), params);
		const text = await res.text();
		return {
			httpResponse: res,
			body: text ? JSON.parse(text) : null
		};
	}
};
//#endregion
//#region extensions/line/src/download.ts
async function downloadLineMedia(messageId, channelAccessToken, maxBytes = 10 * 1024 * 1024) {
	const saved = await saveMediaStream(await new MessagingApiBlobClient({ channelAccessToken }).getMessageContent(messageId), void 0, "inbound", maxBytes);
	logVerbose(`line: persisted media ${messageId} to ${saved.path} (${saved.size} bytes)`);
	return {
		path: saved.path,
		contentType: saved.contentType,
		size: saved.size
	};
}
//#endregion
//#region extensions/line/src/auto-reply-delivery.ts
async function deliverLineAutoReply(params) {
	const { payload, lineData, replyToken, accountId, to, textLimit, deps } = params;
	let replyTokenUsed = params.replyTokenUsed;
	const pushLineMessages = async (messages) => {
		if (messages.length === 0) return;
		for (let i = 0; i < messages.length; i += 5) await deps.pushMessagesLine(to, messages.slice(i, i + 5), {
			cfg: params.cfg,
			accountId
		});
	};
	const sendLineMessages = async (messages, allowReplyToken) => {
		if (messages.length === 0) return;
		let remaining = messages;
		if (allowReplyToken && replyToken && !replyTokenUsed) {
			const replyBatch = remaining.slice(0, 5);
			try {
				await deps.replyMessageLine(replyToken, replyBatch, {
					cfg: params.cfg,
					accountId
				});
			} catch (err) {
				deps.onReplyError?.(err);
				await pushLineMessages(replyBatch);
			}
			replyTokenUsed = true;
			remaining = remaining.slice(replyBatch.length);
		}
		if (remaining.length > 0) await pushLineMessages(remaining);
	};
	const richMessages = [];
	const hasQuickReplies = Boolean(lineData.quickReplies?.length);
	if (lineData.flexMessage) richMessages.push(deps.createFlexMessage(lineData.flexMessage.altText.slice(0, 400), lineData.flexMessage.contents));
	if (lineData.templateMessage) {
		const templateMsg = deps.buildTemplateMessageFromPayload(lineData.templateMessage);
		if (templateMsg) richMessages.push(templateMsg);
	}
	if (lineData.location) richMessages.push(deps.createLocationMessage(lineData.location));
	const processed = payload.text ? deps.processLineMessage(payload.text) : {
		text: "",
		flexMessages: []
	};
	for (const flexMsg of processed.flexMessages) richMessages.push(deps.createFlexMessage(flexMsg.altText.slice(0, 400), flexMsg.contents));
	const chunks = processed.text ? deps.chunkMarkdownText(processed.text, textLimit) : [];
	const mediaMessages = resolveSendableOutboundReplyParts(payload).mediaUrls.map((url) => url?.trim()).filter((url) => Boolean(url)).map((url) => deps.createImageMessage(url));
	if (chunks.length > 0) {
		const hasRichOrMedia = richMessages.length > 0 || mediaMessages.length > 0;
		if (hasQuickReplies && hasRichOrMedia) try {
			await sendLineMessages([...richMessages, ...mediaMessages], false);
		} catch (err) {
			deps.onReplyError?.(err);
		}
		const { replyTokenUsed: nextReplyTokenUsed } = await deps.sendLineReplyChunks({
			to,
			chunks,
			quickReplies: lineData.quickReplies,
			replyToken,
			replyTokenUsed,
			cfg: params.cfg,
			accountId,
			replyMessageLine: deps.replyMessageLine,
			pushMessageLine: deps.pushMessageLine,
			pushTextMessageWithQuickReplies: deps.pushTextMessageWithQuickReplies,
			createTextMessageWithQuickReplies: deps.createTextMessageWithQuickReplies
		});
		replyTokenUsed = nextReplyTokenUsed;
		if (!hasQuickReplies || !hasRichOrMedia) {
			await sendLineMessages(richMessages, false);
			if (mediaMessages.length > 0) await sendLineMessages(mediaMessages, false);
		}
	} else {
		const combined = [...richMessages, ...mediaMessages];
		if (hasQuickReplies && combined.length === 0) {
			const { replyTokenUsed: nextReplyTokenUsed } = await deps.sendLineReplyChunks({
				to,
				chunks: [buildLineQuickReplyFallbackText(lineData.quickReplies)],
				quickReplies: lineData.quickReplies,
				replyToken,
				replyTokenUsed,
				cfg: params.cfg,
				accountId,
				replyMessageLine: deps.replyMessageLine,
				pushMessageLine: deps.pushMessageLine,
				pushTextMessageWithQuickReplies: deps.pushTextMessageWithQuickReplies,
				createTextMessageWithQuickReplies: deps.createTextMessageWithQuickReplies,
				onReplyError: deps.onReplyError
			});
			replyTokenUsed = nextReplyTokenUsed;
		} else {
			if (hasQuickReplies && combined.length > 0) {
				const quickReply = deps.createQuickReplyItems(lineData.quickReplies);
				const targetIndex = replyToken && !replyTokenUsed ? Math.min(4, combined.length - 1) : combined.length - 1;
				combined[targetIndex] = {
					...combined[targetIndex],
					quickReply
				};
			}
			await sendLineMessages(combined, true);
		}
	}
	return { replyTokenUsed };
}
//#endregion
//#region extensions/line/src/bot-message-context.ts
function getLineSourceInfo(source) {
	if (!source) return {
		userId: void 0,
		groupId: void 0,
		roomId: void 0,
		isGroup: false
	};
	return {
		userId: source.type === "user" ? source.userId : source.type === "group" ? source.userId : source.type === "room" ? source.userId : void 0,
		groupId: source.type === "group" ? source.groupId : void 0,
		roomId: source.type === "room" ? source.roomId : void 0,
		isGroup: source.type === "group" || source.type === "room"
	};
}
function buildPeerId(source) {
	if (!source) return "unknown";
	const groupKey = normalizeOptionalString(source.type === "group" ? source.groupId : void 0) ?? normalizeOptionalString(source.type === "room" ? source.roomId : void 0);
	if (groupKey) return groupKey;
	if (source.type === "user" && source.userId) return source.userId;
	return "unknown";
}
async function resolveLineInboundRoute(params) {
	recordChannelActivity({
		channel: "line",
		accountId: params.account.accountId,
		direction: "inbound"
	});
	const { userId, groupId, roomId, isGroup } = getLineSourceInfo(params.source);
	const peerId = buildPeerId(params.source);
	let route = resolveAgentRoute({
		cfg: params.cfg,
		channel: "line",
		accountId: params.account.accountId,
		peer: {
			kind: isGroup ? "group" : "direct",
			id: peerId
		}
	});
	const configuredRoute = resolveConfiguredBindingRoute({
		cfg: params.cfg,
		route,
		conversation: {
			channel: "line",
			accountId: params.account.accountId,
			conversationId: peerId
		}
	});
	let configuredBinding = configuredRoute.bindingResolution;
	const configuredBindingSessionKey = configuredRoute.boundSessionKey ?? "";
	route = configuredRoute.route;
	const runtimeRoute = resolveRuntimeConversationBindingRoute({
		route,
		conversation: {
			channel: "line",
			accountId: params.account.accountId,
			conversationId: peerId
		}
	});
	route = runtimeRoute.route;
	if (runtimeRoute.bindingRecord) {
		configuredBinding = null;
		logVerbose(runtimeRoute.boundSessionKey ? `line: routed via bound conversation ${peerId} -> ${runtimeRoute.boundSessionKey}` : `line: plugin-bound conversation ${peerId}`);
	}
	if (configuredBinding) {
		const ensured = await ensureConfiguredBindingRouteReady({
			cfg: params.cfg,
			bindingResolution: configuredBinding
		});
		if (!ensured.ok) {
			logVerbose(`line: configured ACP binding unavailable for ${peerId} -> ${configuredBindingSessionKey}: ${ensured.error}`);
			throw new Error(`Configured ACP binding unavailable: ${ensured.error}`);
		}
		logVerbose(`line: using configured ACP binding for ${peerId} -> ${configuredBindingSessionKey}`);
	}
	return {
		userId,
		groupId,
		roomId,
		isGroup,
		peerId,
		route
	};
}
const STICKER_PACKAGES = {
	"1": "Moon & James",
	"2": "Cony & Brown",
	"3": "Brown & Friends",
	"4": "Moon Special",
	"789": "LINE Characters",
	"6136": "Cony's Happy Life",
	"6325": "Brown's Life",
	"6359": "Choco",
	"6362": "Sally",
	"6370": "Edward",
	"11537": "Cony",
	"11538": "Brown",
	"11539": "Moon"
};
function describeStickerKeywords(sticker) {
	const keywords = sticker.keywords;
	if (keywords && keywords.length > 0) return keywords.slice(0, 3).join(", ");
	const stickerText = sticker.text;
	if (stickerText) return stickerText;
	return "";
}
function extractMessageText(message) {
	if (message.type === "text") return message.text;
	if (message.type === "location") {
		const loc = message;
		return formatLocationText({
			latitude: loc.latitude,
			longitude: loc.longitude,
			name: loc.title,
			address: loc.address
		}) ?? "";
	}
	if (message.type === "sticker") {
		const sticker = message;
		const packageName = STICKER_PACKAGES[sticker.packageId] ?? "sticker";
		const keywords = describeStickerKeywords(sticker);
		if (keywords) return `[Sent a ${packageName} sticker: ${keywords}]`;
		return `[Sent a ${packageName} sticker]`;
	}
	return "";
}
function extractMediaPlaceholder(message) {
	switch (message.type) {
		case "image": return "<media:image>";
		case "video": return "<media:video>";
		case "audio": return "<media:audio>";
		case "file": return "<media:document>";
		default: return "";
	}
}
function resolveLineConversationLabel(params) {
	return params.isGroup ? params.groupId ? `group:${params.groupId}` : params.roomId ? `room:${params.roomId}` : "unknown-group" : params.senderLabel;
}
function resolveLineAddresses(params) {
	const fromAddress = params.isGroup ? params.groupId ? `line:group:${params.groupId}` : params.roomId ? `line:room:${params.roomId}` : `line:${params.peerId}` : `line:${params.userId ?? params.peerId}`;
	return {
		fromAddress,
		toAddress: params.isGroup ? fromAddress : `line:${params.userId ?? params.peerId}`,
		originatingTo: params.isGroup ? fromAddress : `line:${params.userId ?? params.peerId}`
	};
}
async function finalizeLineInboundContext(params) {
	const { fromAddress, toAddress, originatingTo } = resolveLineAddresses({
		isGroup: params.source.isGroup,
		groupId: params.source.groupId,
		roomId: params.source.roomId,
		userId: params.source.userId,
		peerId: params.source.peerId
	});
	const senderId = params.source.userId ?? "unknown";
	const senderLabel = params.source.userId ? `user:${params.source.userId}` : "unknown";
	const conversationLabel = resolveLineConversationLabel({
		isGroup: params.source.isGroup,
		groupId: params.source.groupId,
		roomId: params.source.roomId,
		senderLabel
	});
	const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
		cfg: params.cfg,
		agentId: params.route.agentId,
		sessionKey: params.route.sessionKey
	});
	const body = formatInboundEnvelope({
		channel: "LINE",
		from: conversationLabel,
		timestamp: params.timestamp,
		body: params.rawBody,
		chatType: params.source.isGroup ? "group" : "direct",
		sender: { id: senderId },
		previousTimestamp,
		envelope: envelopeOptions
	});
	const ctxPayload = finalizeInboundContext({
		Body: body,
		BodyForAgent: params.rawBody,
		RawBody: params.rawBody,
		CommandBody: params.rawBody,
		From: fromAddress,
		To: toAddress,
		SessionKey: params.route.sessionKey,
		AccountId: params.route.accountId,
		ChatType: params.source.isGroup ? "group" : "direct",
		ConversationLabel: conversationLabel,
		GroupSubject: params.source.isGroup ? params.source.groupId ?? params.source.roomId : void 0,
		SenderId: senderId,
		Provider: "line",
		Surface: "line",
		MessageSid: params.messageSid,
		Timestamp: params.timestamp,
		MediaPath: params.media.firstPath,
		MediaType: params.media.firstContentType,
		MediaUrl: params.media.firstPath,
		MediaPaths: params.media.paths,
		MediaUrls: params.media.paths,
		MediaTypes: params.media.types,
		...params.locationContext,
		CommandAuthorized: params.commandAuthorized,
		OriginatingChannel: "line",
		OriginatingTo: originatingTo,
		GroupSystemPrompt: params.source.isGroup ? normalizeOptionalString(resolveLineGroupConfigEntry(params.account.config.groups, {
			groupId: params.source.groupId,
			roomId: params.source.roomId
		})?.systemPrompt) : void 0,
		InboundHistory: params.inboundHistory
	});
	const pinnedMainDmOwner = !params.source.isGroup ? resolvePinnedMainDmOwnerFromAllowlist({
		dmScope: params.cfg.session?.dmScope,
		allowFrom: params.account.config.allowFrom,
		normalizeEntry: (entry) => normalizeAllowFrom([entry]).entries[0]
	}) : null;
	const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
		route: params.route,
		sessionKey: params.route.sessionKey
	});
	if (shouldLogVerbose()) {
		const preview = body.slice(0, 200).replace(/\n/g, "\\n");
		const mediaInfo = params.verboseLog.kind === "inbound" && (params.verboseLog.mediaCount ?? 0) > 1 ? ` mediaCount=${params.verboseLog.mediaCount}` : "";
		logVerbose(`${params.verboseLog.kind === "inbound" ? "line inbound" : "line postback"}: from=${ctxPayload.From} len=${body.length}${mediaInfo} preview="${preview}"`);
	}
	return {
		ctxPayload,
		replyToken: params.event.replyToken,
		turn: {
			storePath,
			record: {
				updateLastRoute: !params.source.isGroup ? {
					sessionKey: inboundLastRouteSessionKey,
					channel: "line",
					to: params.source.userId ?? params.source.peerId,
					accountId: params.route.accountId,
					mainDmOwnerPin: inboundLastRouteSessionKey === params.route.mainSessionKey && pinnedMainDmOwner && params.source.userId ? {
						ownerRecipient: pinnedMainDmOwner,
						senderRecipient: params.source.userId,
						onSkip: ({ ownerRecipient, senderRecipient }) => {
							logVerbose(`line: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`);
						}
					} : void 0
				} : void 0,
				onRecordError: (err) => {
					logVerbose(`line: failed updating session meta: ${String(err)}`);
				}
			}
		}
	};
}
async function buildLineMessageContext(params) {
	const { event, allMedia, cfg, account, commandAuthorized, groupHistories, historyLimit } = params;
	const source = event.source;
	const { userId, groupId, roomId, isGroup, peerId, route } = await resolveLineInboundRoute({
		source,
		cfg,
		account
	});
	const message = event.message;
	const messageId = message.id;
	const timestamp = event.timestamp;
	const textContent = extractMessageText(message);
	const placeholder = extractMediaPlaceholder(message);
	let rawBody = textContent || placeholder;
	if (!rawBody && allMedia.length > 0) rawBody = `<media:image>${allMedia.length > 1 ? ` (${allMedia.length} images)` : ""}`;
	if (!rawBody && allMedia.length === 0) return null;
	let locationContext;
	if (message.type === "location") {
		const loc = message;
		locationContext = toLocationContext({
			latitude: loc.latitude,
			longitude: loc.longitude,
			name: loc.title,
			address: loc.address
		});
	}
	const historyKey = isGroup ? peerId : void 0;
	const inboundHistory = historyKey && groupHistories && (historyLimit ?? 0) > 0 ? createChannelHistoryWindow({ historyMap: groupHistories }).buildInboundHistory({
		historyKey,
		limit: historyLimit ?? 0
	}) : void 0;
	const finalized = await finalizeLineInboundContext({
		cfg,
		account,
		event,
		route,
		source: {
			userId,
			groupId,
			roomId,
			isGroup,
			peerId
		},
		rawBody,
		timestamp,
		messageSid: messageId,
		commandAuthorized,
		media: {
			firstPath: allMedia[0]?.path,
			firstContentType: allMedia[0]?.contentType,
			paths: allMedia.length > 0 ? allMedia.map((m) => m.path) : void 0,
			types: allMedia.length > 0 ? allMedia.map((m) => m.contentType).filter(Boolean) : void 0
		},
		locationContext,
		verboseLog: {
			kind: "inbound",
			mediaCount: allMedia.length
		},
		inboundHistory
	});
	return {
		ctxPayload: finalized.ctxPayload,
		turn: finalized.turn,
		event,
		userId,
		groupId,
		roomId,
		isGroup,
		route,
		replyToken: event.replyToken,
		accountId: account.accountId
	};
}
async function buildLinePostbackContext(params) {
	const { event, cfg, account, commandAuthorized } = params;
	const source = event.source;
	const { userId, groupId, roomId, isGroup, peerId, route } = await resolveLineInboundRoute({
		source,
		cfg,
		account
	});
	const timestamp = event.timestamp;
	const rawData = event.postback?.data?.trim() ?? "";
	if (!rawData) return null;
	let rawBody = rawData;
	if (rawData.includes("line.action=")) {
		const searchParams = new URLSearchParams(rawData);
		const action = searchParams.get("line.action") ?? "";
		const device = searchParams.get("line.device");
		rawBody = device ? `line action ${action} device ${device}` : `line action ${action}`;
	}
	const messageSid = event.replyToken ? `postback:${event.replyToken}` : `postback:${timestamp}`;
	const finalized = await finalizeLineInboundContext({
		cfg,
		account,
		event,
		route,
		source: {
			userId,
			groupId,
			roomId,
			isGroup,
			peerId
		},
		rawBody,
		timestamp,
		messageSid,
		commandAuthorized,
		media: {
			firstPath: "",
			firstContentType: void 0,
			paths: void 0,
			types: void 0
		},
		verboseLog: { kind: "postback" }
	});
	return {
		ctxPayload: finalized.ctxPayload,
		turn: finalized.turn,
		event,
		userId,
		groupId,
		roomId,
		isGroup,
		route,
		replyToken: event.replyToken,
		accountId: account.accountId
	};
}
//#endregion
//#region extensions/line/src/bot-handlers.ts
const LINE_DOWNLOADABLE_MESSAGE_TYPES = new Set([
	"image",
	"video",
	"audio",
	"file"
]);
function isDownloadableLineMessageType(messageType) {
	return LINE_DOWNLOADABLE_MESSAGE_TYPES.has(messageType);
}
const LINE_WEBHOOK_REPLAY_WINDOW_MS = 600 * 1e3;
const LINE_WEBHOOK_REPLAY_MAX_ENTRIES = 4096;
function normalizeLineIngressEntry(value) {
	return normalizeLineAllowEntry(value) || null;
}
var LineRetryableWebhookError = class extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = "LineRetryableWebhookError";
	}
};
function createLineWebhookReplayCache() {
	return createClaimableDedupe({
		ttlMs: LINE_WEBHOOK_REPLAY_WINDOW_MS,
		memoryMaxSize: LINE_WEBHOOK_REPLAY_MAX_ENTRIES
	});
}
function buildLineWebhookReplayKey(event, accountId) {
	if (event.type === "message") {
		const messageId = event.message?.id?.trim();
		if (messageId) return {
			key: `${accountId}|message:${messageId}`,
			eventId: `message:${messageId}`
		};
	}
	const eventId = event.webhookEventId?.trim();
	if (!eventId) return null;
	const source = event.source;
	const sourceId = source?.type === "group" ? `group:${source.groupId ?? ""}` : source?.type === "room" ? `room:${source.roomId ?? ""}` : `user:${source?.userId ?? ""}`;
	return {
		key: `${accountId}|${event.type}|${sourceId}|${eventId}`,
		eventId: `event:${eventId}`
	};
}
function getLineReplayCandidate(event, context) {
	const replay = buildLineWebhookReplayKey(event, context.account.accountId);
	const cache = context.replayCache;
	if (!replay || !cache) return null;
	return {
		key: replay.key,
		eventId: replay.eventId,
		cache
	};
}
async function claimLineReplayEvent(candidate) {
	const claim = await candidate.cache.claim(candidate.key);
	if (claim.kind === "claimed") return { skip: false };
	if (claim.kind === "inflight") {
		logVerbose(`line: skipped in-flight replayed webhook event ${candidate.eventId}`);
		return {
			skip: true,
			inFlightResult: claim.pending.then(() => void 0)
		};
	}
	logVerbose(`line: skipped replayed webhook event ${candidate.eventId}`);
	return { skip: true };
}
function resolveLineGroupConfig(params) {
	return resolveLineGroupConfigEntry(params.config.groups, {
		groupId: params.groupId,
		roomId: params.roomId
	});
}
async function sendLinePairingReply(params) {
	const { senderId, replyToken, context } = params;
	const idLabel = (() => {
		try {
			return resolvePairingIdLabel("line");
		} catch {
			return "lineUserId";
		}
	})();
	await createChannelPairingChallengeIssuer({
		channel: "line",
		upsertPairingRequest: async ({ id, meta }) => await upsertChannelPairingRequest({
			channel: "line",
			id,
			accountId: context.account.accountId,
			meta
		})
	})({
		senderId,
		senderIdLine: `Your ${idLabel}: ${senderId}`,
		onCreated: () => {
			logVerbose(`line pairing request sender=${senderId}`);
		},
		sendPairingReply: async (text) => {
			if (replyToken) try {
				await replyMessageLine(replyToken, [{
					type: "text",
					text
				}], {
					cfg: context.cfg,
					accountId: context.account.accountId,
					channelAccessToken: context.account.channelAccessToken
				});
				return;
			} catch (err) {
				logVerbose(`line pairing reply failed for ${senderId}: ${String(err)}`);
			}
			try {
				await pushMessageLine(`line:${senderId}`, text, {
					cfg: context.cfg,
					accountId: context.account.accountId,
					channelAccessToken: context.account.channelAccessToken
				});
			} catch (err) {
				logVerbose(`line pairing reply failed for ${senderId}: ${String(err)}`);
			}
		}
	});
}
async function shouldProcessLineEvent(event, context) {
	const { cfg, account } = context;
	const { userId, groupId, roomId, isGroup } = getLineSourceInfo(event.source);
	const senderId = userId ?? "";
	const groupConfig = resolveLineGroupConfig({
		config: account.config,
		groupId,
		roomId
	});
	const rawText = resolveEventRawText(event);
	const requireMention = isGroup ? groupConfig?.requireMention !== false : false;
	const dmPolicy = account.config.dmPolicy ?? "pairing";
	const { groupPolicy: runtimeGroupPolicy, providerMissingFallbackApplied } = resolveAllowlistProviderRuntimeGroupPolicy({
		providerConfigPresent: cfg.channels?.line !== void 0,
		groupPolicy: account.config.groupPolicy,
		defaultGroupPolicy: resolveDefaultGroupPolicy(cfg)
	});
	const groupPolicy = runtimeGroupPolicy === "disabled" ? "disabled" : groupConfig?.allowFrom !== void 0 ? "allowlist" : runtimeGroupPolicy;
	const groupAllowFrom = normalizeStringEntries(firstDefined(groupConfig?.allowFrom, account.config.groupAllowFrom, account.config.allowFrom?.length ? account.config.allowFrom : void 0));
	const mentionFacts = (() => {
		if (!isGroup || event.type !== "message") return {
			canDetectMention: false,
			wasMentioned: false,
			hasAnyMention: false
		};
		const peerId = groupId ?? roomId ?? userId ?? "unknown";
		const { agentId } = resolveAgentRoute({
			cfg,
			channel: "line",
			accountId: account.accountId,
			peer: {
				kind: "group",
				id: peerId
			}
		});
		const mentionRegexes = buildMentionRegexes(cfg, agentId);
		const wasMentionedByNative = isLineBotMentioned(event.message);
		const wasMentionedByPattern = event.message.type === "text" ? matchesMentionPatterns(rawText, mentionRegexes) : false;
		return {
			canDetectMention: event.message.type === "text",
			wasMentioned: wasMentionedByNative || wasMentionedByPattern,
			hasAnyMention: hasAnyLineMention(event.message)
		};
	})();
	const access = await resolveStableChannelMessageIngress({
		channelId: "line",
		accountId: account.accountId,
		identity: {
			key: "line-user-id",
			normalize: normalizeLineIngressEntry,
			sensitivity: "pii",
			entryIdPrefix: "line-entry"
		},
		cfg,
		readStoreAllowFrom: async () => await readChannelAllowFromStore("line", void 0, account.accountId),
		subject: { stableId: senderId },
		conversation: {
			kind: isGroup ? "group" : "direct",
			id: (groupId ?? roomId ?? senderId) || "unknown"
		},
		...isGroup && groupConfig?.enabled === false ? { route: {
			id: "line:group-config",
			enabled: false
		} } : {},
		mentionFacts: isGroup && event.type === "message" ? {
			canDetectMention: mentionFacts.canDetectMention,
			wasMentioned: mentionFacts.wasMentioned,
			hasAnyMention: mentionFacts.hasAnyMention,
			implicitMentionKinds: []
		} : void 0,
		event: { kind: event.type === "postback" ? "postback" : "message" },
		dmPolicy,
		groupPolicy,
		policy: {
			groupAllowFromFallbackToAllowFrom: false,
			activation: {
				requireMention: isGroup && event.type === "message" && requireMention,
				allowTextCommands: true
			}
		},
		allowFrom: normalizeStringEntries(account.config.allowFrom),
		groupAllowFrom,
		command: {
			hasControlCommand: shouldComputeCommandAuthorized(rawText, cfg),
			groupOwnerAllowFrom: "none"
		}
	});
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied,
		providerKey: "line",
		accountId: account.accountId,
		log: (message) => logVerbose(message)
	});
	if (access.senderAccess.decision === "allow" && (access.ingress.admission === "dispatch" || access.ingress.admission === "observe" || access.ingress.admission === "skip")) return access;
	if (access.senderAccess.decision === "allow") {
		logVerbose(`Blocked line event (${access.ingress.reasonCode})`);
		return null;
	}
	if (isGroup) {
		if (groupConfig?.enabled === false) {
			logVerbose(`Blocked line group ${groupId ?? roomId ?? "unknown"} (group disabled)`);
			return null;
		}
		if (groupConfig?.allowFrom !== void 0) {
			if (!senderId) {
				logVerbose("Blocked line group message (group allowFrom override, no sender ID)");
				return null;
			}
			if (access.senderAccess.reasonCode !== "group_policy_allowed") {
				logVerbose(`Blocked line group sender ${senderId} (group allowFrom override)`);
				return null;
			}
		}
		if (access.senderAccess.reasonCode === "group_policy_disabled") logVerbose("Blocked line group message (groupPolicy: disabled)");
		else if (!senderId && groupPolicy === "allowlist") logVerbose("Blocked line group message (no sender ID, groupPolicy: allowlist)");
		else if (access.senderAccess.reasonCode === "group_policy_empty_allowlist") logVerbose("Blocked line group message (groupPolicy: allowlist, no groupAllowFrom)");
		else logVerbose(`Blocked line group message from ${senderId} (groupPolicy: allowlist)`);
		return null;
	}
	if (access.senderAccess.reasonCode === "dm_policy_disabled") {
		logVerbose("Blocked line sender (dmPolicy: disabled)");
		return null;
	}
	if (access.senderAccess.decision === "pairing") {
		if (!senderId) {
			logVerbose("Blocked line sender (dmPolicy: pairing, no sender ID)");
			return null;
		}
		await sendLinePairingReply({
			senderId,
			replyToken: "replyToken" in event ? event.replyToken : void 0,
			context
		});
		return null;
	}
	logVerbose(`Blocked line sender ${senderId || "unknown"} (dmPolicy: ${account.config.dmPolicy ?? "pairing"})`);
	return null;
}
function getLineMentionees(message) {
	if (message.type !== "text") return [];
	const mentionees = message.mention?.mentionees;
	return Array.isArray(mentionees) ? mentionees : [];
}
function isLineBotMentioned(message) {
	return getLineMentionees(message).some((m) => m.isSelf === true || m.type === "all");
}
function hasAnyLineMention(message) {
	return getLineMentionees(message).length > 0;
}
function resolveEventRawText(event) {
	if (event.type === "message") {
		const msg = event.message;
		if (msg.type === "text") return msg.text;
		return "";
	}
	if (event.type === "postback") return event.postback?.data?.trim() ?? "";
	return "";
}
async function handleMessageEvent(event, context) {
	const { cfg, account, runtime, mediaMaxBytes, processMessage } = context;
	const message = event.message;
	const decision = await shouldProcessLineEvent(event, context);
	if (!decision) return;
	const { isGroup, groupId, roomId } = getLineSourceInfo(event.source);
	if (isGroup && decision.activationAccess.shouldSkip) {
		const rawText = message.type === "text" ? message.text : "";
		const sourceInfo = getLineSourceInfo(event.source);
		logVerbose(`line: skipping group message (requireMention, not mentioned)`);
		const historyKey = groupId ?? roomId;
		const senderId = sourceInfo.userId ?? "unknown";
		if (historyKey && context.groupHistories) createChannelHistoryWindow({ historyMap: context.groupHistories }).record({
			historyKey,
			limit: context.historyLimit ?? 50,
			entry: {
				sender: `user:${senderId}`,
				body: rawText || `<${message.type}>`,
				timestamp: event.timestamp
			}
		});
		return;
	}
	const allMedia = [];
	if (isDownloadableLineMessageType(message.type)) try {
		const media = await downloadLineMedia(message.id, account.channelAccessToken, mediaMaxBytes);
		allMedia.push({
			path: media.path,
			contentType: media.contentType
		});
	} catch (err) {
		const errMsg = String(err);
		if (errMsg.includes("exceeds") && errMsg.includes("limit")) logVerbose(`line: media exceeds size limit for message ${message.id}`);
		else runtime.error?.(danger(`line: failed to download media: ${errMsg}`));
	}
	const messageContext = await buildLineMessageContext({
		event,
		allMedia,
		cfg,
		account,
		commandAuthorized: decision.commandAccess.authorized,
		groupHistories: context.groupHistories,
		historyLimit: context.historyLimit ?? 50
	});
	if (!messageContext) {
		logVerbose("line: skipping empty message");
		return;
	}
	await processMessage(messageContext);
	if (isGroup && context.groupHistories) {
		const historyKey = groupId ?? roomId;
		if (historyKey && context.groupHistories.has(historyKey)) createChannelHistoryWindow({ historyMap: context.groupHistories }).clear({
			historyKey,
			limit: context.historyLimit ?? 50
		});
	}
}
async function handleFollowEvent(event, _context) {
	const { userId } = getLineSourceInfo(event.source);
	logVerbose(`line: user ${userId ?? "unknown"} followed`);
}
async function handleUnfollowEvent(event, _context) {
	const { userId } = getLineSourceInfo(event.source);
	logVerbose(`line: user ${userId ?? "unknown"} unfollowed`);
}
async function handleJoinEvent(event, _context) {
	const { groupId, roomId } = getLineSourceInfo(event.source);
	logVerbose(`line: bot joined ${groupId ? `group ${groupId}` : `room ${roomId}`}`);
}
async function handleLeaveEvent(event, _context) {
	const { groupId, roomId } = getLineSourceInfo(event.source);
	logVerbose(`line: bot left ${groupId ? `group ${groupId}` : `room ${roomId}`}`);
}
async function handlePostbackEvent(event, context) {
	const data = event.postback.data;
	logVerbose(`line: received postback: ${data}`);
	const decision = await shouldProcessLineEvent(event, context);
	if (!decision) return;
	const postbackContext = await buildLinePostbackContext({
		event,
		cfg: context.cfg,
		account: context.account,
		commandAuthorized: decision.commandAccess.authorized
	});
	if (!postbackContext) return;
	await context.processMessage(postbackContext);
}
async function handleLineWebhookEvents(events, context) {
	let firstError;
	for (const event of events) {
		const replayCandidate = getLineReplayCandidate(event, context);
		const replaySkip = replayCandidate ? await claimLineReplayEvent(replayCandidate) : null;
		if (replaySkip?.skip) {
			if (replaySkip.inFlightResult) try {
				await replaySkip.inFlightResult;
			} catch (err) {
				context.runtime.error?.(danger(`line: replayed in-flight event failed: ${String(err)}`));
				firstError ??= err;
			}
			continue;
		}
		try {
			switch (event.type) {
				case "message":
					await handleMessageEvent(event, context);
					break;
				case "follow":
					await handleFollowEvent(event, context);
					break;
				case "unfollow":
					await handleUnfollowEvent(event, context);
					break;
				case "join":
					await handleJoinEvent(event, context);
					break;
				case "leave":
					await handleLeaveEvent(event, context);
					break;
				case "postback":
					await handlePostbackEvent(event, context);
					break;
				default: logVerbose(`line: unhandled event type: ${event.type}`);
			}
			if (replayCandidate) await replayCandidate.cache.commit(replayCandidate.key);
		} catch (err) {
			if (replayCandidate) if (err instanceof LineRetryableWebhookError) replayCandidate.cache.release(replayCandidate.key, { error: err });
			else await replayCandidate.cache.commit(replayCandidate.key);
			context.runtime.error?.(danger(`line: event handler failed: ${String(err)}`));
			firstError ??= err;
		}
	}
	if (firstError) throw firstError;
}
//#endregion
//#region extensions/line/src/bot.ts
function createLineBot(opts) {
	const runtime = opts.runtime ?? createNonExitingRuntime();
	const cfg = opts.config ?? getRuntimeConfig();
	const account = resolveLineAccount({
		cfg,
		accountId: opts.accountId
	});
	const mediaMaxBytes = (opts.mediaMaxMb ?? account.config.mediaMaxMb ?? 10) * 1024 * 1024;
	const processMessage = opts.onMessage ?? (async () => {
		logVerbose("line: no message handler configured");
	});
	const replayCache = createLineWebhookReplayCache();
	const groupHistories = /* @__PURE__ */ new Map();
	const handleWebhook = async (body) => {
		if (!body.events || body.events.length === 0) return;
		await handleLineWebhookEvents(body.events, {
			cfg,
			account,
			runtime,
			mediaMaxBytes,
			processMessage,
			replayCache,
			groupHistories,
			historyLimit: cfg.messages?.groupChat?.historyLimit ?? 50
		});
	};
	return {
		handleWebhook,
		account
	};
}
//#endregion
//#region extensions/line/src/monitor-durable.ts
function hasLineChannelData(payload) {
	const lineData = payload.channelData?.line;
	return Boolean(lineData && Object.keys(lineData).length > 0);
}
function resolveLineDurableReplyOptions(params) {
	if (params.infoKind !== "final") return false;
	if (params.replyToken && !params.replyTokenUsed) return false;
	if (hasLineChannelData(params.payload)) return false;
	const reply = resolveSendableOutboundReplyParts(params.payload);
	if (reply.hasMedia || !reply.hasText) return false;
	return { to: params.to };
}
//#endregion
//#region extensions/line/src/reply-chunks.ts
async function sendLineReplyChunks(params) {
	const hasQuickReplies = Boolean(params.quickReplies?.length);
	let replyTokenUsed = Boolean(params.replyTokenUsed);
	if (params.chunks.length === 0) return { replyTokenUsed };
	if (params.replyToken && !replyTokenUsed) try {
		const replyBatch = params.chunks.slice(0, 5);
		const remaining = params.chunks.slice(replyBatch.length);
		const replyMessages = replyBatch.map((chunk) => ({
			type: "text",
			text: chunk
		}));
		if (hasQuickReplies && remaining.length === 0 && replyMessages.length > 0) {
			const lastIndex = replyMessages.length - 1;
			replyMessages[lastIndex] = params.createTextMessageWithQuickReplies(replyBatch[lastIndex], params.quickReplies);
		}
		await params.replyMessageLine(params.replyToken, replyMessages, {
			cfg: params.cfg,
			accountId: params.accountId
		});
		replyTokenUsed = true;
		for (let i = 0; i < remaining.length; i += 1) if (i === remaining.length - 1 && hasQuickReplies) await params.pushTextMessageWithQuickReplies(params.to, remaining[i], params.quickReplies, {
			cfg: params.cfg,
			accountId: params.accountId
		});
		else await params.pushMessageLine(params.to, remaining[i], {
			cfg: params.cfg,
			accountId: params.accountId
		});
		return { replyTokenUsed };
	} catch (err) {
		params.onReplyError?.(err);
		replyTokenUsed = true;
	}
	for (let i = 0; i < params.chunks.length; i += 1) if (i === params.chunks.length - 1 && hasQuickReplies) await params.pushTextMessageWithQuickReplies(params.to, params.chunks[i], params.quickReplies, {
		cfg: params.cfg,
		accountId: params.accountId
	});
	else await params.pushMessageLine(params.to, params.chunks[i], {
		cfg: params.cfg,
		accountId: params.accountId
	});
	return { replyTokenUsed };
}
//#endregion
//#region extensions/line/src/signature.ts
function validateLineSignature(body, signature, channelSecret) {
	const hash = crypto.createHmac("SHA256", channelSecret).update(body).digest("base64");
	const hashBuffer = Buffer.from(hash);
	const signatureBuffer = Buffer.from(signature);
	const maxLen = Math.max(hashBuffer.length, signatureBuffer.length);
	const paddedHash = Buffer.alloc(maxLen);
	const paddedSig = Buffer.alloc(maxLen);
	hashBuffer.copy(paddedHash);
	signatureBuffer.copy(paddedSig);
	const timingResult = crypto.timingSafeEqual(paddedHash, paddedSig);
	return hashBuffer.length === signatureBuffer.length && timingResult;
}
//#endregion
//#region extensions/line/src/webhook-utils.ts
function parseLineWebhookBody(rawBody) {
	try {
		return JSON.parse(rawBody);
	} catch {
		return null;
	}
}
//#endregion
//#region extensions/line/src/webhook-node.ts
const LINE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const LINE_WEBHOOK_PREAUTH_MAX_BODY_BYTES$1 = 64 * 1024;
const LINE_WEBHOOK_PREAUTH_BODY_TIMEOUT_MS$1 = 5e3;
async function readLineWebhookRequestBody(req, maxBytes = LINE_WEBHOOK_MAX_BODY_BYTES, timeoutMs = LINE_WEBHOOK_PREAUTH_BODY_TIMEOUT_MS$1) {
	return await readRequestBodyWithLimit(req, {
		maxBytes,
		timeoutMs
	});
}
function logLineWebhookDispatchError(runtime, err) {
	runtime?.error?.(danger(`line webhook dispatch failed: ${String(err)}`));
}
function createLineNodeWebhookHandler(params) {
	const maxBodyBytes = params.maxBodyBytes ?? LINE_WEBHOOK_MAX_BODY_BYTES;
	const readBody = params.readBody ?? readLineWebhookRequestBody;
	return async (req, res) => {
		if (req.method === "GET" || req.method === "HEAD") {
			if (req.method === "HEAD") {
				res.statusCode = 204;
				res.end();
				return;
			}
			res.statusCode = 200;
			res.setHeader("Content-Type", "text/plain");
			res.end("OK");
			return;
		}
		if (req.method !== "POST") {
			res.statusCode = 405;
			res.setHeader("Allow", "GET, HEAD, POST");
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Method Not Allowed" }));
			return;
		}
		let receiveContext;
		try {
			const signatureHeader = req.headers["x-line-signature"];
			const signature = typeof signatureHeader === "string" ? signatureHeader.trim() : Array.isArray(signatureHeader) ? (signatureHeader[0] ?? "").trim() : "";
			if (!signature) {
				logVerbose("line: webhook missing X-Line-Signature header");
				res.statusCode = 400;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: "Missing X-Line-Signature header" }));
				return;
			}
			const rawBody = await readBody(req, Math.min(maxBodyBytes, LINE_WEBHOOK_PREAUTH_MAX_BODY_BYTES$1), LINE_WEBHOOK_PREAUTH_BODY_TIMEOUT_MS$1);
			if (!validateLineSignature(rawBody, signature, params.channelSecret)) {
				logVerbose("line: webhook signature validation failed");
				res.statusCode = 401;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: "Invalid signature" }));
				return;
			}
			const body = parseLineWebhookBody(rawBody);
			if (!body) {
				res.statusCode = 400;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: "Invalid webhook payload" }));
				return;
			}
			params.onRequestAuthenticated?.();
			receiveContext = createMessageReceiveContext({
				id: `${Date.now()}:line:webhook`,
				channel: "line",
				message: body,
				ackPolicy: "after_receive_record",
				onAck: () => {
					res.statusCode = 200;
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({ status: "ok" }));
				}
			});
			if (receiveContext.shouldAckAfter("receive_record")) await receiveContext.ack();
			if (body.events && body.events.length > 0) {
				logVerbose(`line: received ${body.events.length} webhook events`);
				Promise.resolve().then(() => params.bot.handleWebhook(body)).catch((err) => logLineWebhookDispatchError(params.runtime, err));
			}
		} catch (err) {
			await receiveContext?.nack(err);
			if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
				res.statusCode = 413;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: "Payload too large" }));
				return;
			}
			if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
				res.statusCode = 408;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: requestBodyErrorToText("REQUEST_BODY_TIMEOUT") }));
				return;
			}
			params.runtime.error?.(danger(`line webhook error: ${String(err)}`));
			if (!res.headersSent) {
				res.statusCode = 500;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: "Internal server error" }));
			}
		}
	};
}
//#endregion
//#region extensions/line/src/monitor.ts
const runtimeState = /* @__PURE__ */ new Map();
const lineWebhookInFlightLimiter = createWebhookInFlightLimiter();
const LINE_WEBHOOK_PREAUTH_MAX_BODY_BYTES = 64 * 1024;
const LINE_WEBHOOK_PREAUTH_BODY_TIMEOUT_MS = 5e3;
const lineWebhookTargets = /* @__PURE__ */ new Map();
function recordChannelRuntimeState(params) {
	const key = `${params.channel}:${params.accountId}`;
	const existing = runtimeState.get(key) ?? {
		running: false,
		lastStartAt: null,
		lastStopAt: null,
		lastError: null
	};
	runtimeState.set(key, {
		...existing,
		...params.state
	});
}
function startLineLoadingKeepalive(params) {
	const intervalMs = params.intervalMs ?? 18e3;
	const loadingSeconds = params.loadingSeconds ?? 20;
	let stopped = false;
	const trigger = () => {
		if (stopped) return;
		showLoadingAnimation(params.userId, {
			cfg: params.cfg,
			accountId: params.accountId,
			loadingSeconds
		}).catch(() => {});
	};
	trigger();
	const timer = setInterval(trigger, intervalMs);
	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
	};
}
async function monitorLineProvider(opts) {
	const { channelAccessToken, channelSecret, accountId, config, runtime, abortSignal, webhookPath } = opts;
	const resolvedAccountId = accountId ?? resolveDefaultLineAccountId(config);
	const token = channelAccessToken.trim();
	const secret = channelSecret.trim();
	if (!token) throw new Error("LINE webhook mode requires a non-empty channel access token.");
	if (!secret) throw new Error("LINE webhook mode requires a non-empty channel secret.");
	recordChannelRuntimeState({
		channel: "line",
		accountId: resolvedAccountId,
		state: {
			running: true,
			lastStartAt: Date.now()
		}
	});
	const bot = createLineBot({
		channelAccessToken: token,
		channelSecret: secret,
		accountId,
		runtime,
		config,
		onMessage: async (ctx) => {
			if (!ctx) return;
			const { ctxPayload, replyToken, route } = ctx;
			recordChannelRuntimeState({
				channel: "line",
				accountId: resolvedAccountId,
				state: { lastInboundAt: Date.now() }
			});
			const shouldShowLoading = Boolean(ctx.userId && !ctx.isGroup);
			const displayNamePromise = ctx.userId ? getUserDisplayName(ctx.userId, {
				cfg: config,
				accountId: ctx.accountId
			}) : Promise.resolve(ctxPayload.From);
			const stopLoading = shouldShowLoading ? startLineLoadingKeepalive({
				cfg: config,
				userId: ctx.userId,
				accountId: ctx.accountId
			}) : null;
			logVerbose(`line: received message from ${await displayNamePromise} (${ctxPayload.From})`);
			try {
				const textLimit = 5e3;
				let replyTokenUsed = false;
				const core = getLineRuntime();
				const turnResult = await core.channel.turn.run({
					channel: "line",
					accountId: route.accountId,
					raw: ctx,
					adapter: {
						ingest: () => ({
							id: ctxPayload.MessageSid ?? `${ctxPayload.From}:${Date.now()}`,
							rawText: ctxPayload.RawBody ?? ctxPayload.BodyForAgent ?? ""
						}),
						resolveTurn: () => ({
							cfg: config,
							channel: "line",
							accountId: route.accountId,
							agentId: route.agentId,
							routeSessionKey: route.sessionKey,
							storePath: ctx.turn.storePath,
							ctxPayload,
							recordInboundSession: core.channel.session.recordInboundSession,
							dispatchReplyWithBufferedBlockDispatcher: core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
							record: ctx.turn.record,
							replyPipeline: {},
							delivery: {
								durable: (payload, info) => resolveLineDurableReplyOptions({
									payload,
									infoKind: info.kind,
									to: ctxPayload.From,
									replyToken,
									replyTokenUsed
								}),
								deliver: async (payload) => {
									const lineData = payload.channelData?.line ?? {};
									if (ctx.userId && !ctx.isGroup) showLoadingAnimation(ctx.userId, {
										cfg: config,
										accountId: ctx.accountId
									}).catch(() => {});
									const { replyTokenUsed: nextReplyTokenUsed } = await deliverLineAutoReply({
										payload,
										lineData,
										to: ctxPayload.From,
										replyToken,
										replyTokenUsed,
										accountId: ctx.accountId,
										cfg: config,
										textLimit,
										deps: {
											buildTemplateMessageFromPayload,
											processLineMessage,
											chunkMarkdownText,
											sendLineReplyChunks,
											replyMessageLine,
											pushMessageLine,
											pushTextMessageWithQuickReplies,
											createQuickReplyItems,
											createTextMessageWithQuickReplies,
											pushMessagesLine,
											createFlexMessage,
											createImageMessage,
											createLocationMessage,
											onReplyError: (replyErr) => {
												logVerbose(`line: reply token failed, falling back to push: ${String(replyErr)}`);
											}
										}
									});
									replyTokenUsed = nextReplyTokenUsed;
									recordChannelRuntimeState({
										channel: "line",
										accountId: resolvedAccountId,
										state: { lastOutboundAt: Date.now() }
									});
								},
								onError: (err, info) => {
									runtime.error?.(danger(`line ${info.kind} reply failed: ${String(err)}`));
								}
							}
						})
					}
				});
				if (!hasFinalChannelTurnDispatch(turnResult.dispatched ? turnResult.dispatchResult : void 0)) logVerbose(`line: no response generated for message from ${ctxPayload.From}`);
			} catch (err) {
				runtime.error?.(danger(`line: auto-reply failed: ${String(err)}`));
				if (replyToken) try {
					await replyMessageLine(replyToken, [{
						type: "text",
						text: "Sorry, I encountered an error processing your message."
					}], {
						cfg: config,
						accountId: ctx.accountId
					});
				} catch (replyErr) {
					runtime.error?.(danger(`line: error reply failed: ${String(replyErr)}`));
				}
			} finally {
				stopLoading?.();
			}
		}
	});
	const normalizedPath = normalizePluginHttpPath(webhookPath, "/line/webhook") ?? "/line/webhook";
	const createScopedLineWebhookHandler = (target) => createLineNodeWebhookHandler({
		channelSecret: target.channelSecret,
		bot: target.bot,
		runtime: target.runtime
	});
	const { unregister: unregisterHttp } = registerWebhookTargetWithPluginRoute({
		targetsByPath: lineWebhookTargets,
		target: {
			accountId: resolvedAccountId,
			bot,
			channelSecret: secret,
			path: normalizedPath,
			runtime
		},
		route: {
			auth: "plugin",
			pluginId: "line",
			accountId: resolvedAccountId,
			log: (msg) => logVerbose(msg),
			handler: async (req, res) => {
				const targets = lineWebhookTargets.get(normalizedPath) ?? [];
				const firstTarget = targets[0];
				if (req.method !== "POST") {
					if (!firstTarget) {
						res.statusCode = 404;
						res.end("Not Found");
						return;
					}
					await createScopedLineWebhookHandler(firstTarget)(req, res);
					return;
				}
				const requestLifecycle = beginWebhookRequestPipelineOrReject({
					req,
					res,
					inFlightLimiter: lineWebhookInFlightLimiter,
					inFlightKey: `line:${normalizedPath}`
				});
				if (!requestLifecycle.ok) return;
				try {
					const signatureHeader = req.headers["x-line-signature"];
					const signature = typeof signatureHeader === "string" ? signatureHeader.trim() : Array.isArray(signatureHeader) ? (signatureHeader[0] ?? "").trim() : "";
					if (!signature) {
						logVerbose("line: webhook missing X-Line-Signature header");
						res.statusCode = 400;
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify({ error: "Missing X-Line-Signature header" }));
						return;
					}
					const rawBody = await readLineWebhookRequestBody(req, LINE_WEBHOOK_PREAUTH_MAX_BODY_BYTES, LINE_WEBHOOK_PREAUTH_BODY_TIMEOUT_MS);
					const match = resolveSingleWebhookTarget(targets, (target) => validateLineSignature(rawBody, signature, target.channelSecret));
					if (match.kind === "none") {
						logVerbose("line: webhook signature validation failed");
						res.statusCode = 401;
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify({ error: "Invalid signature" }));
						return;
					}
					if (match.kind === "ambiguous") {
						logVerbose("line: webhook signature matched multiple accounts");
						res.statusCode = 401;
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify({ error: "Ambiguous webhook target" }));
						return;
					}
					const body = parseLineWebhookBody(rawBody);
					if (!body) {
						res.statusCode = 400;
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify({ error: "Invalid webhook payload" }));
						return;
					}
					requestLifecycle.release();
					res.statusCode = 200;
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({ status: "ok" }));
					if (body.events && body.events.length > 0) {
						logVerbose(`line: received ${body.events.length} webhook events`);
						Promise.resolve().then(() => match.target.bot.handleWebhook(body)).catch((err) => {
							match.target.runtime.error?.(danger(`line webhook dispatch failed: ${String(err)}`));
						});
					}
				} catch (err) {
					if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
						res.statusCode = 413;
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify({ error: "Payload too large" }));
						return;
					}
					if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
						res.statusCode = 408;
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify({ error: requestBodyErrorToText("REQUEST_BODY_TIMEOUT") }));
						return;
					}
					runtime.error?.(danger(`line webhook error: ${String(err)}`));
					if (!res.headersSent) {
						res.statusCode = 500;
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify({ error: "Internal server error" }));
					}
				} finally {
					requestLifecycle.release();
				}
			}
		}
	});
	logVerbose(`line: registered webhook handler at ${normalizedPath}`);
	let stopped = false;
	const stopHandler = () => {
		if (stopped) return;
		stopped = true;
		logVerbose(`line: stopping provider for account ${resolvedAccountId}`);
		unregisterHttp();
		recordChannelRuntimeState({
			channel: "line",
			accountId: resolvedAccountId,
			state: {
				running: false,
				lastStopAt: Date.now()
			}
		});
	};
	if (abortSignal?.aborted) stopHandler();
	else if (abortSignal) {
		abortSignal.addEventListener("abort", stopHandler, { once: true });
		await waitForAbortSignal(abortSignal);
	}
	return {
		account: bot.account,
		handleWebhook: bot.handleWebhook,
		stop: () => {
			stopHandler();
			abortSignal?.removeEventListener("abort", stopHandler);
		}
	};
}
//#endregion
export { validateLineSignature as a, normalizeAllowFrom as c, parseLineWebhookBody as i, createLineNodeWebhookHandler as n, downloadLineMedia as o, readLineWebhookRequestBody as r, MessagingApiBlobClient as s, monitorLineProvider as t };
