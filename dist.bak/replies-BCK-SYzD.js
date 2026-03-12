import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { i as isSilentReplyText, n as SILENT_REPLY_TOKEN } from "./tokens-BbMquAae.js";
import { r as markdownToSlackMrkdwnChunks, t as sendMessageSlack } from "./send-CuT_IAxo.js";
import { i as chunkMarkdownTextWithMode } from "./chunk-BhlcoTjA.js";

//#region src/auto-reply/reply/reply-reference.ts
function createReplyReferencePlanner(options) {
	let hasReplied = options.hasReplied ?? false;
	const allowReference = options.allowReference !== false;
	const existingId = options.existingId?.trim();
	const startId = options.startId?.trim();
	const use = () => {
		if (!allowReference) return;
		if (options.replyToMode === "off") return;
		const id = existingId ?? startId;
		if (!id) return;
		if (options.replyToMode === "all") {
			hasReplied = true;
			return id;
		}
		if (!hasReplied) {
			hasReplied = true;
			return id;
		}
	};
	const markSent = () => {
		hasReplied = true;
	};
	return {
		use,
		markSent,
		hasReplied: () => hasReplied
	};
}

//#endregion
//#region src/slack/monitor/replies.ts
var replies_exports = /* @__PURE__ */ __exportAll({
	createSlackReplyDeliveryPlan: () => createSlackReplyDeliveryPlan,
	deliverReplies: () => deliverReplies,
	deliverSlackSlashReplies: () => deliverSlackSlashReplies,
	resolveSlackThreadTs: () => resolveSlackThreadTs
});
async function deliverReplies(params) {
	for (const payload of params.replies) {
		const threadTs = (params.replyToMode === "off" ? void 0 : payload.replyToId) ?? params.replyThreadTs;
		const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
		const text = payload.text ?? "";
		if (!text && mediaList.length === 0) continue;
		if (mediaList.length === 0) {
			const trimmed = text.trim();
			if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) continue;
			await sendMessageSlack(params.target, trimmed, {
				token: params.token,
				threadTs,
				accountId: params.accountId
			});
		} else {
			let first = true;
			for (const mediaUrl of mediaList) {
				const caption = first ? text : "";
				first = false;
				await sendMessageSlack(params.target, caption, {
					token: params.token,
					mediaUrl,
					threadTs,
					accountId: params.accountId
				});
			}
		}
		params.runtime.log?.(`delivered reply to ${params.target}`);
	}
}
/**
* Compute effective threadTs for a Slack reply based on replyToMode.
* - "off": stay in thread if already in one, otherwise main channel
* - "first": first reply goes to thread, subsequent replies to main channel
* - "all": all replies go to thread
*/
function resolveSlackThreadTs(params) {
	return createSlackReplyReferencePlanner({
		replyToMode: params.replyToMode,
		incomingThreadTs: params.incomingThreadTs,
		messageTs: params.messageTs,
		hasReplied: params.hasReplied,
		isThreadReply: params.isThreadReply
	}).use();
}
function createSlackReplyReferencePlanner(params) {
	return createReplyReferencePlanner({
		replyToMode: params.isThreadReply ?? Boolean(params.incomingThreadTs) ? "all" : params.replyToMode,
		existingId: params.incomingThreadTs,
		startId: params.messageTs,
		hasReplied: params.hasReplied
	});
}
function createSlackReplyDeliveryPlan(params) {
	const replyReference = createSlackReplyReferencePlanner({
		replyToMode: params.replyToMode,
		incomingThreadTs: params.incomingThreadTs,
		messageTs: params.messageTs,
		hasReplied: params.hasRepliedRef.value,
		isThreadReply: params.isThreadReply
	});
	return {
		nextThreadTs: () => replyReference.use(),
		markSent: () => {
			replyReference.markSent();
			params.hasRepliedRef.value = replyReference.hasReplied();
		}
	};
}
async function deliverSlackSlashReplies(params) {
	const messages = [];
	const chunkLimit = Math.min(params.textLimit, 4e3);
	for (const payload of params.replies) {
		const textRaw = payload.text?.trim() ?? "";
		const text = textRaw && !isSilentReplyText(textRaw, SILENT_REPLY_TOKEN) ? textRaw : void 0;
		const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
		const combined = [text ?? "", ...mediaList.map((url) => url.trim()).filter(Boolean)].filter(Boolean).join("\n");
		if (!combined) continue;
		const chunkMode = params.chunkMode ?? "length";
		const chunks = (chunkMode === "newline" ? chunkMarkdownTextWithMode(combined, chunkLimit, chunkMode) : [combined]).flatMap((markdown) => markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode: params.tableMode }));
		if (!chunks.length && combined) chunks.push(combined);
		for (const chunk of chunks) messages.push(chunk);
	}
	if (messages.length === 0) return;
	const responseType = params.ephemeral ? "ephemeral" : "in_channel";
	for (const text of messages) await params.respond({
		text,
		response_type: responseType
	});
}

//#endregion
export { createReplyReferencePlanner as a, resolveSlackThreadTs as i, deliverReplies as n, replies_exports as r, createSlackReplyDeliveryPlan as t };