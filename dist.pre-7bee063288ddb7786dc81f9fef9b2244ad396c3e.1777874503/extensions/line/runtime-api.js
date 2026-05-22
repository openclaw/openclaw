import { a as normalizeLowercaseStringOrEmpty } from "../../string-coerce-Bje8XVt9.js";
import { t as formatDocsLink } from "../../links-BszRQhGa.js";
import { r as logVerbose, t as danger } from "../../globals-C7I_COwU.js";
import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-DUpVOe8L.js";
import { r as buildChannelConfigSchema } from "../../config-schema-C2n-k4o1.js";
import { r as getAgentScopedMediaLocalRoots } from "../../local-roots-CUkWYVtg.js";
import { n as loadWebMediaRaw } from "../../web-media-Cd1lDznL.js";
import { t as clearAccountEntryFields } from "../../config-helpers-DyBVgEMG.js";
import { r as stripMarkdown } from "../../text-runtime-icMZVCaq.js";
import "../../core-BYja3dMh.js";
import { t as firstDefined } from "../../allow-from-CZulnYsH.js";
import "../../channel-config-schema-CaU4N9C9.js";
import { J as setSetupChannelEnabled, Q as splitSetupEntries } from "../../setup-wizard-helpers-D8cUTbTq.js";
import { o as buildTokenChannelStatusSummary, r as buildComputedAccountStatusSnapshot } from "../../status-helpers-BvzPNo7p.js";
import "../../runtime-env-BBcuHj0d.js";
import "../../setup-C421YIRA.js";
import "../../agent-media-payload-Bw_KuN8B.js";
import "../../web-media-BfqF04MS.js";
import { i as resolveLineAccount, n as normalizeAccountId, r as resolveDefaultLineAccountId, t as listLineAccountIds } from "../../accounts-TsP32LLk.js";
import { a as resolveLineGroupConfigEntry, i as resolveExactLineGroupConfigKey, o as resolveLineGroupLookupIds, r as setLineRuntime, s as resolveLineGroupsConfig } from "../../quick-reply-fallback-9pR8bqBx.js";
import { a as createMediaPlayerCard, i as createDeviceControlCard, n as parseLineDirectives, o as LineChannelConfigSchema, r as createAppleTvRemoteCard, s as LineConfigSchema, t as hasLineDirectives } from "../../reply-payload-transform-B9hQN3Eo.js";
import { n as createEventCard, r as createReceiptCard, t as createAgendaCard } from "../../schedule-cards-C7qjnwoX.js";
import { a as createListCard, i as createInfoCard, n as createCarousel, o as createNotificationBubble, r as createImageCard, t as createActionCard } from "../../basic-cards-aivoVBTP.js";
import { A as createButtonMenu, B as datetimePickerAction, C as pushTemplateMessage, D as showLoadingAnimation, E as sendMessageLine, F as createImageCarouselColumn, H as postbackAction, I as createLinkMenu, L as createProductCarousel, M as createCarouselColumn, N as createConfirmTemplate, O as resolveLineChannelAccessToken, P as createImageCarousel, R as createTemplateCarousel, S as pushMessagesLine, T as replyMessageLine, U as uriAction, V as messageAction, W as toFlexMessage, _ as getUserProfile, a as extractLinks, b as pushLocationMessage, c as processLineMessage, d as createImageMessage, f as createLocationMessage, g as getUserDisplayName, h as createVideoMessage, i as extractCodeBlocks, j as createButtonTemplate, k as buildTemplateMessageFromPayload, l as createAudioMessage, m as createTextMessageWithQuickReplies, n as convertLinksToFlexBubble, o as extractMarkdownTables, p as createQuickReplyItems, r as convertTableToFlexBubble, s as hasMarkdownToConvert, t as convertCodeBlockToFlexBubble, u as createFlexMessage, v as pushFlexMessage, w as pushTextMessageWithQuickReplies, x as pushMessageLine, y as pushImageMessage, z as createYesNoConfirm } from "../../markdown-to-line-BXL6Yel1.js";
import { a as validateLineSignature, c as isSenderAllowed, i as parseLineWebhookBody, l as normalizeAllowFrom, n as createLineNodeWebhookHandler, o as downloadLineMedia, r as readLineWebhookRequestBody, s as MessagingApiBlobClient, t as monitorLineProvider, u as normalizeDmAllowFromWithStore } from "../../monitor-CsREdnC5.js";
import { t as MessagingApiClient } from "../../messagingApiClient-BiHeDLkF.js";
import { t as probeLineBot } from "../../probe-PgWXXiKM.js";
//#region extensions/line/src/webhook.ts
const LINE_WEBHOOK_MAX_RAW_BODY_BYTES = 64 * 1024;
function readRawBody(req) {
	const rawBody = req.rawBody ?? (typeof req.body === "string" || Buffer.isBuffer(req.body) ? req.body : null);
	if (!rawBody) return null;
	return Buffer.isBuffer(rawBody) ? rawBody.toString("utf-8") : rawBody;
}
function parseWebhookBody(rawBody) {
	if (!rawBody) return null;
	return parseLineWebhookBody(rawBody);
}
function createLineWebhookMiddleware(options) {
	const { channelSecret, onEvents, runtime } = options;
	return async (req, res, _next) => {
		try {
			const signature = req.headers["x-line-signature"];
			if (!signature || typeof signature !== "string") {
				res.status(400).json({ error: "Missing X-Line-Signature header" });
				return;
			}
			const rawBody = readRawBody(req);
			if (!rawBody) {
				res.status(400).json({ error: "Missing raw request body for signature verification" });
				return;
			}
			if (Buffer.byteLength(rawBody, "utf-8") > LINE_WEBHOOK_MAX_RAW_BODY_BYTES) {
				res.status(413).json({ error: "Payload too large" });
				return;
			}
			if (!validateLineSignature(rawBody, signature, channelSecret)) {
				logVerbose("line: webhook signature validation failed");
				res.status(401).json({ error: "Invalid signature" });
				return;
			}
			const body = parseWebhookBody(rawBody);
			if (!body) {
				res.status(400).json({ error: "Invalid webhook payload" });
				return;
			}
			if (body.events && body.events.length > 0) {
				logVerbose(`line: received ${body.events.length} webhook events`);
				await onEvents(body);
			}
			res.status(200).json({ status: "ok" });
		} catch (err) {
			runtime?.error?.(danger(`line webhook error: ${String(err)}`));
			if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
		}
	};
}
function startLineWebhook(options) {
	const channelSecret = typeof options.channelSecret === "string" ? options.channelSecret.trim() : "";
	if (!channelSecret) throw new Error("LINE webhook mode requires a non-empty channel secret. Set channels.line.channelSecret in your config.");
	return {
		path: options.path ?? "/line/webhook",
		handler: createLineWebhookMiddleware({
			channelSecret,
			onEvents: options.onEvents,
			runtime: options.runtime
		})
	};
}
//#endregion
//#region extensions/line/src/rich-menu.ts
const USER_BATCH_SIZE = 500;
function getClient(opts) {
	const account = resolveLineAccount({
		cfg: opts.cfg,
		accountId: opts.accountId
	});
	return new MessagingApiClient({ channelAccessToken: resolveLineChannelAccessToken(opts.channelAccessToken, account) });
}
function getBlobClient(opts) {
	const account = resolveLineAccount({
		cfg: opts.cfg,
		accountId: opts.accountId
	});
	return new MessagingApiBlobClient({ channelAccessToken: resolveLineChannelAccessToken(opts.channelAccessToken, account) });
}
function chunkUserIds(userIds) {
	const batches = [];
	for (let i = 0; i < userIds.length; i += USER_BATCH_SIZE) batches.push(userIds.slice(i, i + USER_BATCH_SIZE));
	return batches;
}
async function createRichMenu(menu, opts) {
	const client = getClient(opts);
	const richMenuRequest = {
		size: menu.size,
		selected: menu.selected ?? false,
		name: menu.name.slice(0, 300),
		chatBarText: menu.chatBarText.slice(0, 14),
		areas: menu.areas
	};
	const response = await client.createRichMenu(richMenuRequest);
	if (opts.verbose) logVerbose(`line: created rich menu ${response.richMenuId}`);
	return response.richMenuId;
}
async function uploadRichMenuImage(richMenuId, imagePath, opts) {
	const blobClient = getBlobClient(opts);
	const media = await loadWebMediaRaw(imagePath, { localRoots: opts.mediaLocalRoots ?? getAgentScopedMediaLocalRoots(opts.cfg) });
	const contentType = media.contentType === "image/png" || media.contentType === "image/jpeg" ? media.contentType : normalizeLowercaseStringOrEmpty(imagePath).endsWith(".png") ? "image/png" : "image/jpeg";
	const imageBytes = new ArrayBuffer(media.buffer.byteLength);
	new Uint8Array(imageBytes).set(media.buffer);
	await blobClient.setRichMenuImage(richMenuId, new Blob([imageBytes], { type: contentType }));
	if (opts.verbose) logVerbose(`line: uploaded image to rich menu ${richMenuId}`);
}
async function setDefaultRichMenu(richMenuId, opts) {
	await getClient(opts).setDefaultRichMenu(richMenuId);
	if (opts.verbose) logVerbose(`line: set default rich menu to ${richMenuId}`);
}
async function cancelDefaultRichMenu(opts) {
	await getClient(opts).cancelDefaultRichMenu();
	if (opts.verbose) logVerbose("line: cancelled default rich menu");
}
async function getDefaultRichMenuId(opts) {
	const client = getClient(opts);
	try {
		return (await client.getDefaultRichMenuId()).richMenuId ?? null;
	} catch {
		return null;
	}
}
async function linkRichMenuToUser(userId, richMenuId, opts) {
	await getClient(opts).linkRichMenuIdToUser(userId, richMenuId);
	if (opts.verbose) logVerbose(`line: linked rich menu ${richMenuId} to user ${userId}`);
}
async function linkRichMenuToUsers(userIds, richMenuId, opts) {
	const client = getClient(opts);
	for (const batch of chunkUserIds(userIds)) await client.linkRichMenuIdToUsers({
		richMenuId,
		userIds: batch
	});
	if (opts.verbose) logVerbose(`line: linked rich menu ${richMenuId} to ${userIds.length} users`);
}
async function unlinkRichMenuFromUser(userId, opts) {
	await getClient(opts).unlinkRichMenuIdFromUser(userId);
	if (opts.verbose) logVerbose(`line: unlinked rich menu from user ${userId}`);
}
async function unlinkRichMenuFromUsers(userIds, opts) {
	const client = getClient(opts);
	for (const batch of chunkUserIds(userIds)) await client.unlinkRichMenuIdFromUsers({ userIds: batch });
	if (opts.verbose) logVerbose(`line: unlinked rich menu from ${userIds.length} users`);
}
async function getRichMenuIdOfUser(userId, opts) {
	const client = getClient(opts);
	try {
		return (await client.getRichMenuIdOfUser(userId)).richMenuId ?? null;
	} catch {
		return null;
	}
}
async function getRichMenuList(opts) {
	return (await getClient(opts).getRichMenuList()).richmenus ?? [];
}
async function getRichMenu(richMenuId, opts) {
	const client = getClient(opts);
	try {
		return await client.getRichMenu(richMenuId);
	} catch {
		return null;
	}
}
async function deleteRichMenu(richMenuId, opts) {
	await getClient(opts).deleteRichMenu(richMenuId);
	if (opts.verbose) logVerbose(`line: deleted rich menu ${richMenuId}`);
}
async function createRichMenuAlias(richMenuId, aliasId, opts) {
	await getClient(opts).createRichMenuAlias({
		richMenuId,
		richMenuAliasId: aliasId
	});
	if (opts.verbose) logVerbose(`line: created alias ${aliasId} for rich menu ${richMenuId}`);
}
async function deleteRichMenuAlias(aliasId, opts) {
	await getClient(opts).deleteRichMenuAlias(aliasId);
	if (opts.verbose) logVerbose(`line: deleted alias ${aliasId}`);
}
function createGridLayout(height, actions) {
	const colWidth = Math.floor(2500 / 3);
	const rowHeight = Math.floor(height / 2);
	return [
		{
			bounds: {
				x: 0,
				y: 0,
				width: colWidth,
				height: rowHeight
			},
			action: actions[0]
		},
		{
			bounds: {
				x: colWidth,
				y: 0,
				width: colWidth,
				height: rowHeight
			},
			action: actions[1]
		},
		{
			bounds: {
				x: colWidth * 2,
				y: 0,
				width: colWidth,
				height: rowHeight
			},
			action: actions[2]
		},
		{
			bounds: {
				x: 0,
				y: rowHeight,
				width: colWidth,
				height: rowHeight
			},
			action: actions[3]
		},
		{
			bounds: {
				x: colWidth,
				y: rowHeight,
				width: colWidth,
				height: rowHeight
			},
			action: actions[4]
		},
		{
			bounds: {
				x: colWidth * 2,
				y: rowHeight,
				width: colWidth,
				height: rowHeight
			},
			action: actions[5]
		}
	];
}
function createDefaultMenuConfig() {
	return {
		size: {
			width: 2500,
			height: 843
		},
		selected: false,
		name: "Default Menu",
		chatBarText: "Menu",
		areas: createGridLayout(843, [
			messageAction("Help", "/help"),
			messageAction("Status", "/status"),
			messageAction("Settings", "/settings"),
			messageAction("About", "/about"),
			messageAction("Feedback", "/feedback"),
			messageAction("Contact", "/contact")
		])
	};
}
//#endregion
export { DEFAULT_ACCOUNT_ID, LineChannelConfigSchema, LineConfigSchema, buildChannelConfigSchema, buildComputedAccountStatusSnapshot, buildTemplateMessageFromPayload, buildTokenChannelStatusSummary, cancelDefaultRichMenu, clearAccountEntryFields, convertCodeBlockToFlexBubble, convertLinksToFlexBubble, convertTableToFlexBubble, createActionCard, createAgendaCard, createAppleTvRemoteCard, createAudioMessage, createButtonMenu, createButtonTemplate, createCarousel, createCarouselColumn, createConfirmTemplate, createDefaultMenuConfig, createDeviceControlCard, createEventCard, createFlexMessage, createGridLayout, createImageCard, createImageCarousel, createImageCarouselColumn, createImageMessage, createInfoCard, createLineNodeWebhookHandler, createLineWebhookMiddleware, createLinkMenu, createListCard, createLocationMessage, createMediaPlayerCard, createNotificationBubble, createProductCarousel, createQuickReplyItems, createReceiptCard, createRichMenu, createRichMenuAlias, createTemplateCarousel, createTextMessageWithQuickReplies, createVideoMessage, createYesNoConfirm, datetimePickerAction, deleteRichMenu, deleteRichMenuAlias, downloadLineMedia, extractCodeBlocks, extractLinks, extractMarkdownTables, firstDefined, formatDocsLink, getDefaultRichMenuId, getRichMenu, getRichMenuIdOfUser, getRichMenuList, getUserDisplayName, getUserProfile, hasLineDirectives, hasMarkdownToConvert, isSenderAllowed, linkRichMenuToUser, linkRichMenuToUsers, listLineAccountIds, messageAction, monitorLineProvider, normalizeAccountId, normalizeAllowFrom, normalizeDmAllowFromWithStore, parseLineDirectives, parseLineWebhookBody, postbackAction, probeLineBot, processLineMessage, pushFlexMessage, pushImageMessage, pushLocationMessage, pushMessageLine, pushMessagesLine, pushTemplateMessage, pushTextMessageWithQuickReplies, readLineWebhookRequestBody, replyMessageLine, resolveDefaultLineAccountId, resolveExactLineGroupConfigKey, resolveLineAccount, resolveLineChannelAccessToken, resolveLineGroupConfigEntry, resolveLineGroupLookupIds, resolveLineGroupsConfig, sendMessageLine, setDefaultRichMenu, setLineRuntime, setSetupChannelEnabled, showLoadingAnimation, splitSetupEntries, startLineWebhook, stripMarkdown, toFlexMessage, unlinkRichMenuFromUser, unlinkRichMenuFromUsers, uploadRichMenuImage, uriAction, validateLineSignature };
