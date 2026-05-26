import { t as createMessageReceiptFromOutboundResults } from "./receipt-vrVTwZtS.js";
import "./channel-message-DMGbyII_.js";
import { m as isRecord } from "./accounts-Djfj3q-S.js";
//#region extensions/feishu/src/card-interaction.ts
const FEISHU_CARD_INTERACTION_VERSION = "ocf1";
function isInteractionKind(value) {
	return value === "button" || value === "quick" || value === "meta";
}
function isMetadataValue(value) {
	return value === null || value === void 0 || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
function createFeishuCardInteractionEnvelope(envelope) {
	return {
		oc: FEISHU_CARD_INTERACTION_VERSION,
		...envelope
	};
}
function buildFeishuCardActionTextFallback(event) {
	const actionValue = event.action.value;
	if (isRecord(actionValue)) {
		if (typeof actionValue.text === "string") return actionValue.text;
		if (typeof actionValue.command === "string") return actionValue.command;
		return JSON.stringify(actionValue);
	}
	return String(actionValue);
}
function decodeFeishuCardAction(params) {
	const { event, now = Date.now() } = params;
	const actionValue = event.action.value;
	if (!isRecord(actionValue) || actionValue.oc !== "ocf1") return {
		kind: "legacy",
		text: buildFeishuCardActionTextFallback(event)
	};
	if (!isInteractionKind(actionValue.k) || typeof actionValue.a !== "string" || !actionValue.a) return {
		kind: "invalid",
		reason: "malformed"
	};
	if (actionValue.q !== void 0 && typeof actionValue.q !== "string") return {
		kind: "invalid",
		reason: "malformed"
	};
	if (actionValue.m !== void 0) {
		if (!isRecord(actionValue.m)) return {
			kind: "invalid",
			reason: "malformed"
		};
		for (const value of Object.values(actionValue.m)) if (!isMetadataValue(value)) return {
			kind: "invalid",
			reason: "malformed"
		};
	}
	if (actionValue.c !== void 0) {
		if (!isRecord(actionValue.c)) return {
			kind: "invalid",
			reason: "malformed"
		};
		if (actionValue.c.u !== void 0 && typeof actionValue.c.u !== "string") return {
			kind: "invalid",
			reason: "malformed"
		};
		if (actionValue.c.h !== void 0 && typeof actionValue.c.h !== "string") return {
			kind: "invalid",
			reason: "malformed"
		};
		if (actionValue.c.s !== void 0 && typeof actionValue.c.s !== "string") return {
			kind: "invalid",
			reason: "malformed"
		};
		if (actionValue.c.e !== void 0 && !Number.isFinite(actionValue.c.e)) return {
			kind: "invalid",
			reason: "malformed"
		};
		if (actionValue.c.t !== void 0 && actionValue.c.t !== "p2p" && actionValue.c.t !== "group") return {
			kind: "invalid",
			reason: "malformed"
		};
		if (typeof actionValue.c.e === "number" && actionValue.c.e < now) return {
			kind: "invalid",
			reason: "stale"
		};
		const expectedUser = actionValue.c.u?.trim();
		if (expectedUser && expectedUser !== (event.operator.open_id ?? "").trim()) return {
			kind: "invalid",
			reason: "wrong_user"
		};
		const expectedChat = actionValue.c.h?.trim();
		if (expectedChat && expectedChat !== (event.context.chat_id ?? "").trim()) return {
			kind: "invalid",
			reason: "wrong_conversation"
		};
	}
	return {
		kind: "structured",
		envelope: actionValue
	};
}
//#endregion
//#region extensions/feishu/src/send-result.ts
function resolveFeishuReceiptKind(msgType) {
	switch (msgType) {
		case "audio": return "voice";
		case "image":
		case "media":
		case "file": return "media";
		case "interactive": return "card";
		case "post":
		case "text": return "text";
		default: return "unknown";
	}
}
function createFeishuSendReceipt(params) {
	const messageId = params.messageId?.trim();
	const chatId = params.chatId.trim();
	return createMessageReceiptFromOutboundResults({
		results: messageId ? [{
			channel: "feishu",
			messageId,
			chatId,
			conversationId: chatId
		}] : [],
		...chatId ? { threadId: chatId } : {},
		kind: params.kind ?? "unknown"
	});
}
function assertFeishuMessageApiSuccess(response, errorPrefix) {
	if (response.code !== 0) throw new Error(`${errorPrefix}: ${response.msg || `code ${response.code}`}`);
}
function toFeishuSendResult(response, chatId, kind) {
	const messageId = response.data?.message_id ?? "unknown";
	return {
		messageId,
		chatId,
		receipt: createFeishuSendReceipt({
			messageId,
			chatId,
			kind
		})
	};
}
//#endregion
export { FEISHU_CARD_INTERACTION_VERSION as a, decodeFeishuCardAction as c, toFeishuSendResult as i, createFeishuSendReceipt as n, buildFeishuCardActionTextFallback as o, resolveFeishuReceiptKind as r, createFeishuCardInteractionEnvelope as s, assertFeishuMessageApiSuccess as t };
