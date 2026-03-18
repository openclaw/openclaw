import { Nl as chunkMarkdownTextWithMode, Rd as isSilentReplyText, bl as sendMessageSlack, xl as markdownToSlackMrkdwnChunks, zl as parseSlackBlocksInput } from "./model-selection-DTQXVq3-.js";
import { t as createReplyReferencePlanner } from "./reply-reference-Bq73SyWy.js";
//#region extensions/slack/src/monitor/replies.ts
function readSlackReplyBlocks(payload) {
	const slackData = payload.channelData?.slack;
	if (!slackData || typeof slackData !== "object" || Array.isArray(slackData)) return;
	try {
		return parseSlackBlocksInput(slackData.blocks);
	} catch {
		return;
	}
}
async function deliverReplies(params) {
	for (const payload of params.replies) {
		const threadTs = (params.replyToMode === "off" ? void 0 : payload.replyToId) ?? params.replyThreadTs;
		const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
		const text = payload.text ?? "";
		const slackBlocks = readSlackReplyBlocks(payload);
		if (!text && mediaList.length === 0 && !slackBlocks?.length) continue;
		if (mediaList.length === 0) {
			const trimmed = text.trim();
			if (!trimmed && !slackBlocks?.length) continue;
			if (trimmed && isSilentReplyText(trimmed, "NO_REPLY")) continue;
			await sendMessageSlack(params.target, trimmed, {
				token: params.token,
				threadTs,
				accountId: params.accountId,
				...slackBlocks?.length ? { blocks: slackBlocks } : {},
				...params.identity ? { identity: params.identity } : {}
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
					accountId: params.accountId,
					...params.identity ? { identity: params.identity } : {}
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
		const text = textRaw && !isSilentReplyText(textRaw, "NO_REPLY") ? textRaw : void 0;
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
export { resolveSlackThreadTs as a, readSlackReplyBlocks as i, deliverReplies as n, deliverSlackSlashReplies as r, createSlackReplyDeliveryPlan as t };
