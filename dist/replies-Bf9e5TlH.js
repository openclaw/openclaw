import { t as createReplyReferencePlanner } from "./reply-reference-BWpe6PiT.js";
import { i as deliverTextOrMediaReply, m as resolveSendableOutboundReplyParts } from "./reply-payload-BOrd8HRU.js";
import { a as isSilentReplyText } from "./tokens-CUA96vf1.js";
import { i as chunkMarkdownTextWithMode } from "./chunk-CGVwhsnj.js";
import "./reply-reference-B2sOmJ2G.js";
import "./reply-chunking-DnJ1jlVh.js";
import { r as SLACK_TEXT_LIMIT } from "./thread-ts-DWLXPVhT.js";
import { t as resolveSlackReplyBlocks } from "./reply-blocks-VBmaHhOr.js";
import { o as markdownToSlackMrkdwnChunks, t as sendMessageSlack } from "./send-N1ZXm8DK.js";
import "./send.runtime-CzUICsUl.js";
//#region extensions/slack/src/monitor/replies.ts
function readSlackReplyBlocks(payload) {
	return resolveSlackReplyBlocks(payload);
}
function resolveDeliveredSlackReplyThreadTs(params) {
	return (params.replyToMode === "off" ? void 0 : params.payloadReplyToId) ?? params.replyThreadTs;
}
async function deliverReplies(params) {
	for (const payload of params.replies) {
		const threadTs = resolveDeliveredSlackReplyThreadTs({
			replyToMode: params.replyToMode,
			payloadReplyToId: payload.replyToId,
			replyThreadTs: params.replyThreadTs
		});
		const reply = resolveSendableOutboundReplyParts(payload);
		const slackBlocks = readSlackReplyBlocks(payload);
		if (!reply.hasContent && !slackBlocks?.length) continue;
		if (!reply.hasMedia && slackBlocks?.length) {
			const trimmed = reply.trimmedText;
			if (!trimmed && !slackBlocks?.length) continue;
			if (trimmed && isSilentReplyText(trimmed, "NO_REPLY")) continue;
			await sendMessageSlack(params.target, trimmed, {
				cfg: params.cfg,
				token: params.token,
				threadTs,
				accountId: params.accountId,
				...slackBlocks?.length ? { blocks: slackBlocks } : {},
				...params.identity ? { identity: params.identity } : {}
			});
			params.runtime.log?.(`delivered reply to ${params.target}`);
			continue;
		}
		if (await deliverTextOrMediaReply({
			payload,
			text: reply.text,
			chunkText: !reply.hasMedia ? (value) => {
				const trimmed = value.trim();
				if (!trimmed || isSilentReplyText(trimmed, "NO_REPLY")) return [];
				return [trimmed];
			} : void 0,
			sendText: async (trimmed) => {
				await sendMessageSlack(params.target, trimmed, {
					cfg: params.cfg,
					token: params.token,
					threadTs,
					accountId: params.accountId,
					...params.identity ? { identity: params.identity } : {}
				});
			},
			sendMedia: async ({ mediaUrl, caption }) => {
				await sendMessageSlack(params.target, caption ?? "", {
					cfg: params.cfg,
					token: params.token,
					mediaUrl,
					threadTs,
					accountId: params.accountId,
					...params.identity ? { identity: params.identity } : {}
				});
			}
		}) !== "empty") params.runtime.log?.(`delivered reply to ${params.target}`);
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
		replyToMode: params.isThreadReply ?? Boolean(params.incomingThreadTs && params.incomingThreadTs !== params.messageTs) ? "all" : params.replyToMode,
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
		peekThreadTs: () => replyReference.peek(),
		nextThreadTs: () => replyReference.use(),
		markSent: () => {
			replyReference.markSent();
			params.hasRepliedRef.value = replyReference.hasReplied();
		}
	};
}
async function deliverSlackSlashReplies(params) {
	const messages = [];
	const chunkLimit = Math.min(params.textLimit, SLACK_TEXT_LIMIT);
	for (const payload of params.replies) {
		const reply = resolveSendableOutboundReplyParts(payload);
		const slackBlocks = readSlackReplyBlocks(payload);
		const text = reply.hasText && !isSilentReplyText(reply.trimmedText, "NO_REPLY") ? reply.trimmedText : void 0;
		if (slackBlocks?.length && !reply.hasMedia) {
			messages.push({
				text: text ?? "",
				blocks: slackBlocks
			});
			continue;
		}
		const combined = [text ?? "", ...reply.mediaUrls].filter(Boolean).join("\n");
		if (!combined) continue;
		const chunkMode = params.chunkMode ?? "length";
		const chunks = (chunkMode === "newline" ? chunkMarkdownTextWithMode(combined, chunkLimit, chunkMode) : [combined]).flatMap((markdown) => markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode: params.tableMode }));
		if (!chunks.length && combined) chunks.push(combined);
		for (const chunk of chunks) messages.push({ text: chunk });
	}
	if (messages.length === 0) return;
	const responseType = params.ephemeral ? "ephemeral" : "in_channel";
	for (const message of messages) await params.respond({
		...message,
		response_type: responseType
	});
}
//#endregion
export { resolveDeliveredSlackReplyThreadTs as a, readSlackReplyBlocks as i, deliverReplies as n, resolveSlackThreadTs as o, deliverSlackSlashReplies as r, createSlackReplyDeliveryPlan as t };
