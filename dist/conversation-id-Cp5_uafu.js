import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
//#region extensions/feishu/src/conversation-id.ts
function normalizeText(value) {
	if (typeof value !== "string") return;
	return value.trim() || void 0;
}
function buildFeishuConversationId(params) {
	const chatId = normalizeText(params.chatId) ?? "unknown";
	const senderOpenId = normalizeText(params.senderOpenId);
	const topicId = normalizeText(params.topicId);
	switch (params.scope) {
		case "group_sender": return senderOpenId ? `${chatId}:sender:${senderOpenId}` : chatId;
		case "group_topic": return topicId ? `${chatId}:topic:${topicId}` : chatId;
		case "group_topic_sender":
			if (topicId && senderOpenId) return `${chatId}:topic:${topicId}:sender:${senderOpenId}`;
			if (topicId) return `${chatId}:topic:${topicId}`;
			return senderOpenId ? `${chatId}:sender:${senderOpenId}` : chatId;
		default: return chatId;
	}
}
function parseFeishuTargetId(raw) {
	const target = normalizeText(raw);
	if (!target) return;
	const withoutProvider = target.replace(/^(feishu|lark):/i, "").trim();
	if (!withoutProvider) return;
	const lowered = normalizeLowercaseStringOrEmpty(withoutProvider);
	for (const prefix of [
		"chat:",
		"group:",
		"channel:",
		"user:",
		"dm:",
		"open_id:"
	]) if (lowered.startsWith(prefix)) return normalizeText(withoutProvider.slice(prefix.length));
	return withoutProvider;
}
function parseFeishuDirectConversationId(raw) {
	const target = normalizeText(raw);
	if (!target) return;
	const withoutProvider = target.replace(/^(feishu|lark):/i, "").trim();
	if (!withoutProvider) return;
	const lowered = normalizeLowercaseStringOrEmpty(withoutProvider);
	for (const prefix of [
		"user:",
		"dm:",
		"open_id:"
	]) if (lowered.startsWith(prefix)) return normalizeText(withoutProvider.slice(prefix.length));
	const id = parseFeishuTargetId(target);
	if (!id) return;
	if (id.startsWith("ou_") || id.startsWith("on_")) return id;
}
function parseFeishuConversationId(params) {
	const conversationId = normalizeText(params.conversationId);
	const parentConversationId = normalizeText(params.parentConversationId);
	if (!conversationId) return null;
	const topicSenderMatch = conversationId.match(/^(.+):topic:([^:]+):sender:([^:]+)$/i);
	if (topicSenderMatch) {
		const [, chatId, topicId, senderOpenId] = topicSenderMatch;
		return {
			canonicalConversationId: buildFeishuConversationId({
				chatId,
				scope: "group_topic_sender",
				topicId,
				senderOpenId
			}),
			chatId,
			topicId,
			senderOpenId,
			scope: "group_topic_sender"
		};
	}
	const topicMatch = conversationId.match(/^(.+):topic:([^:]+)$/i);
	if (topicMatch) {
		const [, chatId, topicId] = topicMatch;
		return {
			canonicalConversationId: buildFeishuConversationId({
				chatId,
				scope: "group_topic",
				topicId
			}),
			chatId,
			topicId,
			scope: "group_topic"
		};
	}
	const senderMatch = conversationId.match(/^(.+):sender:([^:]+)$/i);
	if (senderMatch) {
		const [, chatId, senderOpenId] = senderMatch;
		return {
			canonicalConversationId: buildFeishuConversationId({
				chatId,
				scope: "group_sender",
				senderOpenId
			}),
			chatId,
			senderOpenId,
			scope: "group_sender"
		};
	}
	if (parentConversationId) return {
		canonicalConversationId: buildFeishuConversationId({
			chatId: parentConversationId,
			scope: "group_topic",
			topicId: conversationId
		}),
		chatId: parentConversationId,
		topicId: conversationId,
		scope: "group_topic"
	};
	return {
		canonicalConversationId: conversationId,
		chatId: conversationId,
		scope: "group"
	};
}
function buildFeishuModelOverrideParentCandidates(parentConversationId) {
	const rawId = normalizeText(parentConversationId);
	if (!rawId) return [];
	const topicSenderMatch = rawId.match(/^(.+):topic:([^:]+):sender:([^:]+)$/i);
	if (topicSenderMatch) {
		const chatId = normalizeLowercaseStringOrEmpty(topicSenderMatch[1]);
		const topicId = normalizeLowercaseStringOrEmpty(topicSenderMatch[2]);
		if (chatId && topicId) return [`${chatId}:topic:${topicId}`, chatId];
		return [];
	}
	const topicMatch = rawId.match(/^(.+):topic:([^:]+)$/i);
	if (topicMatch) {
		const chatId = normalizeLowercaseStringOrEmpty(topicMatch[1]);
		return chatId ? [chatId] : [];
	}
	const senderMatch = rawId.match(/^(.+):sender:([^:]+)$/i);
	if (senderMatch) {
		const chatId = normalizeLowercaseStringOrEmpty(senderMatch[1]);
		return chatId ? [chatId] : [];
	}
	return [];
}
//#endregion
export { parseFeishuTargetId as a, parseFeishuDirectConversationId as i, buildFeishuModelOverrideParentCandidates as n, parseFeishuConversationId as r, buildFeishuConversationId as t };
