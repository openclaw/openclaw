import { t as createMessageReceiptFromOutboundResults } from "./receipt-vrVTwZtS.js";
import "./channel-message-DMGbyII_.js";
//#region extensions/discord/src/send.receipt.ts
function createDiscordSendReceipt(params) {
	return createMessageReceiptFromOutboundResults({
		results: params.platformMessageIds.map((messageId) => messageId.trim()).filter((messageId) => messageId && messageId !== "unknown").map((messageId) => {
			const result = {
				channel: "discord",
				messageId
			};
			if (params.channelId) result.channelId = params.channelId;
			return result;
		}),
		kind: params.kind,
		threadId: params.threadId,
		replyToId: params.replyToId
	});
}
function createDiscordSendResult(params) {
	const messageId = params.result.id || "unknown";
	const channelId = params.result.channel_id ?? params.fallbackChannelId;
	const receiptParams = {
		platformMessageIds: params.result.platformMessageIds?.length ? params.result.platformMessageIds : [messageId],
		channelId,
		kind: params.kind
	};
	if (params.threadId != null) receiptParams.threadId = String(params.threadId);
	if (params.replyToId) receiptParams.replyToId = params.replyToId;
	return {
		messageId,
		channelId,
		receipt: createDiscordSendReceipt(receiptParams)
	};
}
//#endregion
export { createDiscordSendResult as n, createDiscordSendReceipt as t };
