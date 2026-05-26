import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { r as parseFeishuConversationId, t as buildFeishuConversationId } from "./conversation-id-Cp5_uafu.js";
import { r as normalizeFeishuTarget } from "./targets-BVM6OB3d.js";
import { n as getFeishuThreadBindingManager } from "./thread-bindings-Bzs7fwqh.js";
//#region extensions/feishu/src/subagent-hooks.ts
function summarizeError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return "error";
}
function stripProviderPrefix(raw) {
	return raw.replace(/^(feishu|lark):/i, "").trim();
}
function resolveFeishuRequesterConversation(params) {
	const manager = getFeishuThreadBindingManager(params.accountId);
	if (!manager) return null;
	const rawTo = params.to?.trim();
	const withoutProviderPrefix = rawTo ? stripProviderPrefix(rawTo) : "";
	const normalizedTarget = rawTo ? normalizeFeishuTarget(rawTo) : null;
	const threadId = params.threadId != null && params.threadId !== "" ? String(params.threadId).trim() : "";
	const isChatTarget = /^(chat|group|channel):/i.test(withoutProviderPrefix);
	const parsedRequesterTopic = normalizedTarget && threadId && isChatTarget ? parseFeishuConversationId({
		conversationId: buildFeishuConversationId({
			chatId: normalizedTarget,
			scope: "group_topic",
			topicId: threadId
		}),
		parentConversationId: normalizedTarget
	}) : null;
	const requesterSessionKey = params.requesterSessionKey?.trim();
	if (requesterSessionKey) {
		const existingBindings = manager.listBySessionKey(requesterSessionKey);
		if (existingBindings.length === 1) {
			const existing = existingBindings[0];
			return {
				accountId: existing.accountId,
				conversationId: existing.conversationId,
				parentConversationId: existing.parentConversationId
			};
		}
		if (existingBindings.length > 1) {
			if (rawTo && normalizedTarget && !threadId && !isChatTarget) {
				const directMatches = existingBindings.filter((entry) => entry.accountId === manager.accountId && entry.conversationId === normalizedTarget && !entry.parentConversationId);
				if (directMatches.length === 1) {
					const existing = directMatches[0];
					return {
						accountId: existing.accountId,
						conversationId: existing.conversationId,
						parentConversationId: existing.parentConversationId
					};
				}
				return null;
			}
			if (parsedRequesterTopic) {
				const matchingTopicBindings = existingBindings.filter((entry) => {
					const parsed = parseFeishuConversationId({
						conversationId: entry.conversationId,
						parentConversationId: entry.parentConversationId
					});
					return parsed?.chatId === parsedRequesterTopic.chatId && parsed?.topicId === parsedRequesterTopic.topicId;
				});
				if (matchingTopicBindings.length === 1) {
					const existing = matchingTopicBindings[0];
					return {
						accountId: existing.accountId,
						conversationId: existing.conversationId,
						parentConversationId: existing.parentConversationId
					};
				}
				const senderScopedTopicBindings = matchingTopicBindings.filter((entry) => {
					return parseFeishuConversationId({
						conversationId: entry.conversationId,
						parentConversationId: entry.parentConversationId
					})?.scope === "group_topic_sender";
				});
				if (senderScopedTopicBindings.length === 1 && matchingTopicBindings.length === senderScopedTopicBindings.length) {
					const existing = senderScopedTopicBindings[0];
					return {
						accountId: existing.accountId,
						conversationId: existing.conversationId,
						parentConversationId: existing.parentConversationId
					};
				}
				return null;
			}
		}
	}
	if (!rawTo) return null;
	if (!normalizedTarget) return null;
	if (threadId) {
		if (!isChatTarget) return null;
		return {
			accountId: manager.accountId,
			conversationId: buildFeishuConversationId({
				chatId: normalizedTarget,
				scope: "group_topic",
				topicId: threadId
			}),
			parentConversationId: normalizedTarget
		};
	}
	if (isChatTarget) return null;
	return {
		accountId: manager.accountId,
		conversationId: normalizedTarget
	};
}
function resolveFeishuDeliveryOrigin(params) {
	const deliveryTo = params.deliveryTo?.trim();
	const deliveryThreadId = params.deliveryThreadId?.trim();
	if (deliveryTo) return {
		channel: "feishu",
		accountId: params.accountId,
		to: deliveryTo,
		...deliveryThreadId ? { threadId: deliveryThreadId } : {}
	};
	const parsed = parseFeishuConversationId({
		conversationId: params.conversationId,
		parentConversationId: params.parentConversationId
	});
	if (parsed?.topicId) return {
		channel: "feishu",
		accountId: params.accountId,
		to: `chat:${params.parentConversationId?.trim() || parsed.chatId}`,
		threadId: parsed.topicId
	};
	return {
		channel: "feishu",
		accountId: params.accountId,
		to: `user:${params.conversationId}`
	};
}
function resolveMatchingChildBinding(params) {
	const manager = getFeishuThreadBindingManager(params.accountId);
	if (!manager) return null;
	const childBindings = manager.listBySessionKey(params.childSessionKey.trim());
	if (childBindings.length === 0) return null;
	const requesterConversation = resolveFeishuRequesterConversation({
		accountId: manager.accountId,
		to: params.requesterOrigin?.to,
		threadId: params.requesterOrigin?.threadId,
		requesterSessionKey: params.requesterSessionKey
	});
	if (requesterConversation) {
		const matched = childBindings.find((entry) => entry.accountId === requesterConversation.accountId && entry.conversationId === requesterConversation.conversationId && normalizeOptionalString(entry.parentConversationId) === normalizeOptionalString(requesterConversation.parentConversationId));
		if (matched) return matched;
	}
	return childBindings.length === 1 ? childBindings[0] : null;
}
async function handleFeishuSubagentSpawning(event, ctx) {
	if (!event.threadRequested) return;
	if (normalizeOptionalLowercaseString(event.requester?.channel) !== "feishu") return;
	const manager = getFeishuThreadBindingManager(event.requester?.accountId);
	if (!manager) return {
		status: "error",
		error: "Feishu current-conversation binding is unavailable because the Feishu account monitor is not active."
	};
	const conversation = resolveFeishuRequesterConversation({
		accountId: event.requester?.accountId,
		to: event.requester?.to,
		threadId: event.requester?.threadId,
		requesterSessionKey: ctx.requesterSessionKey
	});
	if (!conversation) return {
		status: "error",
		error: "Feishu current-conversation binding is only available in direct messages or topic conversations."
	};
	try {
		const binding = manager.bindConversation({
			conversationId: conversation.conversationId,
			parentConversationId: conversation.parentConversationId,
			targetKind: "subagent",
			targetSessionKey: event.childSessionKey,
			metadata: {
				agentId: event.agentId,
				label: event.label,
				boundBy: "system",
				deliveryTo: event.requester?.to,
				deliveryThreadId: event.requester?.threadId != null && event.requester.threadId !== "" ? String(event.requester.threadId) : void 0
			}
		});
		if (!binding) return {
			status: "error",
			error: "Unable to bind this Feishu conversation to the spawned subagent session. Session mode is unavailable for this target."
		};
		return {
			status: "ok",
			threadBindingReady: true,
			deliveryOrigin: resolveFeishuDeliveryOrigin({
				conversationId: binding.conversationId,
				parentConversationId: binding.parentConversationId,
				accountId: binding.accountId,
				deliveryTo: binding.deliveryTo,
				deliveryThreadId: binding.deliveryThreadId
			})
		};
	} catch (err) {
		return {
			status: "error",
			error: `Feishu conversation bind failed: ${summarizeError(err)}`
		};
	}
}
function handleFeishuSubagentDeliveryTarget(event) {
	if (!event.expectsCompletionMessage) return;
	if (normalizeOptionalLowercaseString(event.requesterOrigin?.channel) !== "feishu") return;
	const binding = resolveMatchingChildBinding({
		accountId: event.requesterOrigin?.accountId,
		childSessionKey: event.childSessionKey,
		requesterSessionKey: event.requesterSessionKey,
		requesterOrigin: {
			to: event.requesterOrigin?.to,
			threadId: event.requesterOrigin?.threadId
		}
	});
	if (!binding) return;
	return { origin: resolveFeishuDeliveryOrigin({
		conversationId: binding.conversationId,
		parentConversationId: binding.parentConversationId,
		accountId: binding.accountId,
		deliveryTo: binding.deliveryTo,
		deliveryThreadId: binding.deliveryThreadId
	}) };
}
function handleFeishuSubagentEnded(event) {
	getFeishuThreadBindingManager(event.accountId)?.unbindBySessionKey(event.targetSessionKey);
}
//#endregion
export { handleFeishuSubagentEnded as n, handleFeishuSubagentSpawning as r, handleFeishuSubagentDeliveryTarget as t };
