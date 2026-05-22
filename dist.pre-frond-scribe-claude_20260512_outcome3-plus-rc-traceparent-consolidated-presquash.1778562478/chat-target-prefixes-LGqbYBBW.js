import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { s as normalizeStringEntries } from "./string-normalization-C5SGsaST.js";
//#region src/channels/plugins/chat-target-prefixes.ts
function isAllowedParsedChatSender(params) {
	const allowFrom = normalizeStringEntries(params.allowFrom);
	if (allowFrom.length === 0) return false;
	if (allowFrom.includes("*")) return true;
	const senderNormalized = params.normalizeSender(params.sender);
	const chatId = params.chatId ?? void 0;
	const chatGuid = normalizeOptionalString(params.chatGuid);
	const chatIdentifier = normalizeOptionalString(params.chatIdentifier);
	for (const entry of allowFrom) {
		if (!entry) continue;
		const parsed = params.parseAllowTarget(entry);
		if (parsed.kind === "chat_id" && chatId !== void 0) {
			if (parsed.chatId === chatId) return true;
		} else if (parsed.kind === "chat_guid" && chatGuid) {
			if (parsed.chatGuid === chatGuid) return true;
		} else if (parsed.kind === "chat_identifier" && chatIdentifier) {
			if (parsed.chatIdentifier === chatIdentifier) return true;
		} else if (parsed.kind === "handle" && senderNormalized) {
			if (parsed.handle === senderNormalized) return true;
		}
	}
	return false;
}
function stripPrefix(value, prefix) {
	return value.slice(prefix.length).trim();
}
function startsWithAnyPrefix(value, prefixes) {
	return prefixes.some((prefix) => value.startsWith(prefix));
}
function resolveServicePrefixedTarget(params) {
	for (const { prefix, service } of params.servicePrefixes) {
		if (!params.lower.startsWith(prefix)) continue;
		const remainder = stripPrefix(params.trimmed, prefix);
		if (!remainder) throw new Error(`${prefix} target is required`);
		const remainderLower = normalizeLowercaseStringOrEmpty(remainder);
		if (params.isChatTarget(remainderLower)) return params.parseTarget(remainder);
		return {
			kind: "handle",
			to: remainder,
			service
		};
	}
	return null;
}
function resolveServicePrefixedChatTarget(params) {
	const chatPrefixes = [
		...params.chatIdPrefixes,
		...params.chatGuidPrefixes,
		...params.chatIdentifierPrefixes,
		...params.extraChatPrefixes ?? []
	];
	return resolveServicePrefixedTarget({
		trimmed: params.trimmed,
		lower: params.lower,
		servicePrefixes: params.servicePrefixes,
		isChatTarget: (remainderLower) => startsWithAnyPrefix(remainderLower, chatPrefixes),
		parseTarget: params.parseTarget
	});
}
function parseChatTargetPrefixesOrThrow(params) {
	for (const prefix of params.chatIdPrefixes) if (params.lower.startsWith(prefix)) {
		const value = stripPrefix(params.trimmed, prefix);
		const chatId = Number.parseInt(value, 10);
		if (!Number.isFinite(chatId)) throw new Error(`Invalid chat_id: ${value}`);
		return {
			kind: "chat_id",
			chatId
		};
	}
	for (const prefix of params.chatGuidPrefixes) if (params.lower.startsWith(prefix)) {
		const value = stripPrefix(params.trimmed, prefix);
		if (!value) throw new Error("chat_guid is required");
		return {
			kind: "chat_guid",
			chatGuid: value
		};
	}
	for (const prefix of params.chatIdentifierPrefixes) if (params.lower.startsWith(prefix)) {
		const value = stripPrefix(params.trimmed, prefix);
		if (!value) throw new Error("chat_identifier is required");
		return {
			kind: "chat_identifier",
			chatIdentifier: value
		};
	}
	return null;
}
function resolveServicePrefixedAllowTarget(params) {
	for (const { prefix } of params.servicePrefixes) {
		if (!params.lower.startsWith(prefix)) continue;
		const remainder = stripPrefix(params.trimmed, prefix);
		if (!remainder) return {
			kind: "handle",
			handle: ""
		};
		return params.parseAllowTarget(remainder);
	}
	return null;
}
function resolveServicePrefixedOrChatAllowTarget(params) {
	const servicePrefixed = resolveServicePrefixedAllowTarget({
		trimmed: params.trimmed,
		lower: params.lower,
		servicePrefixes: params.servicePrefixes,
		parseAllowTarget: params.parseAllowTarget
	});
	if (servicePrefixed) return servicePrefixed;
	const chatTarget = parseChatAllowTargetPrefixes({
		trimmed: params.trimmed,
		lower: params.lower,
		chatIdPrefixes: params.chatIdPrefixes,
		chatGuidPrefixes: params.chatGuidPrefixes,
		chatIdentifierPrefixes: params.chatIdentifierPrefixes
	});
	if (chatTarget) return chatTarget;
	return null;
}
function createAllowedChatSenderMatcher(params) {
	return (input) => isAllowedParsedChatSender({
		allowFrom: input.allowFrom,
		sender: input.sender,
		chatId: input.chatId,
		chatGuid: input.chatGuid,
		chatIdentifier: input.chatIdentifier,
		normalizeSender: params.normalizeSender,
		parseAllowTarget: params.parseAllowTarget
	});
}
function parseChatAllowTargetPrefixes(params) {
	for (const prefix of params.chatIdPrefixes) if (params.lower.startsWith(prefix)) {
		const value = stripPrefix(params.trimmed, prefix);
		const chatId = Number.parseInt(value, 10);
		if (Number.isFinite(chatId)) return {
			kind: "chat_id",
			chatId
		};
	}
	for (const prefix of params.chatGuidPrefixes) if (params.lower.startsWith(prefix)) {
		const value = stripPrefix(params.trimmed, prefix);
		if (value) return {
			kind: "chat_guid",
			chatGuid: value
		};
	}
	for (const prefix of params.chatIdentifierPrefixes) if (params.lower.startsWith(prefix)) {
		const value = stripPrefix(params.trimmed, prefix);
		if (value) return {
			kind: "chat_identifier",
			chatIdentifier: value
		};
	}
	return null;
}
//#endregion
export { resolveServicePrefixedAllowTarget as a, resolveServicePrefixedTarget as c, parseChatTargetPrefixesOrThrow as i, isAllowedParsedChatSender as n, resolveServicePrefixedChatTarget as o, parseChatAllowTargetPrefixes as r, resolveServicePrefixedOrChatAllowTarget as s, createAllowedChatSenderMatcher as t };
