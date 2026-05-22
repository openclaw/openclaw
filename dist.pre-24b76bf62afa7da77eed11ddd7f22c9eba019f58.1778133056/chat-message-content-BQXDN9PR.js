import { f as readStringValue } from "./string-coerce-Bje8XVt9.js";
//#region src/shared/chat-message-content.ts
function extractFirstTextBlock(message) {
	if (!message || typeof message !== "object") return;
	const content = message.content;
	const inline = readStringValue(content);
	if (inline !== void 0) return inline;
	if (!Array.isArray(content) || content.length === 0) return;
	const first = content[0];
	if (!first || typeof first !== "object") return;
	return readStringValue(first.text);
}
function normalizeAssistantPhase(value) {
	return value === "commentary" || value === "final_answer" ? value : void 0;
}
function parseAssistantTextSignature(value) {
	if (typeof value !== "string" || value.trim().length === 0) return null;
	if (!value.startsWith("{")) return { id: value };
	try {
		const parsed = JSON.parse(value);
		if (parsed.v !== 1) return null;
		return {
			...typeof parsed.id === "string" ? { id: parsed.id } : {},
			...normalizeAssistantPhase(parsed.phase) ? { phase: normalizeAssistantPhase(parsed.phase) } : {}
		};
	} catch {
		return null;
	}
}
function encodeAssistantTextSignature(params) {
	return JSON.stringify({
		v: 1,
		id: params.id,
		...params.phase ? { phase: params.phase } : {}
	});
}
function resolveAssistantMessagePhase(message) {
	if (!message || typeof message !== "object") return;
	const entry = message;
	const directPhase = normalizeAssistantPhase(entry.phase);
	if (directPhase) return directPhase;
	if (!Array.isArray(entry.content)) return;
	const explicitPhases = /* @__PURE__ */ new Set();
	for (const block of entry.content) {
		if (!block || typeof block !== "object") continue;
		const record = block;
		if (record.type !== "text") continue;
		const phase = parseAssistantTextSignature(record.textSignature)?.phase;
		if (phase) explicitPhases.add(phase);
	}
	return explicitPhases.size === 1 ? [...explicitPhases][0] : void 0;
}
function resolveAssistantEventPhase(data) {
	if (!data || typeof data !== "object") return;
	const record = data;
	return normalizeAssistantPhase(record.phase) ?? resolveAssistantMessagePhase(record.message) ?? resolveAssistantMessagePhase(record.partial) ?? resolveAssistantMessagePhase(record.item) ?? resolveAssistantMessagePhase(record);
}
function extractAssistantTextForPhase(message, options) {
	if (!message || typeof message !== "object") return;
	const entry = message;
	const messagePhase = normalizeAssistantPhase(entry.phase);
	const phase = options?.phase;
	const shouldIncludeContent = (resolvedPhase) => {
		if (phase) return resolvedPhase === phase;
		return resolvedPhase === void 0;
	};
	const sanitizeText = options?.sanitizeText;
	const joinWith = options?.joinWith ?? "\n";
	const sanitizeBlockText = (text) => sanitizeText ? sanitizeText(text) : text;
	const normalizeJoinedText = (text) => {
		return text.trim() || void 0;
	};
	if (typeof entry.text === "string") {
		if (!shouldIncludeContent(messagePhase)) return;
		return normalizeJoinedText(sanitizeBlockText(entry.text));
	}
	if (typeof entry.content === "string") {
		if (!shouldIncludeContent(messagePhase)) return;
		return normalizeJoinedText(sanitizeBlockText(entry.content));
	}
	if (!Array.isArray(entry.content)) return;
	const hasExplicitPhasedTextBlocks = entry.content.some((block) => {
		if (!block || typeof block !== "object") return false;
		const record = block;
		if (record.type !== "text") return false;
		return Boolean(parseAssistantTextSignature(record.textSignature)?.phase);
	});
	if (!phase && hasExplicitPhasedTextBlocks) return;
	const parts = entry.content.map((block) => {
		if (!block || typeof block !== "object") return null;
		const record = block;
		if (record.type !== "text" || typeof record.text !== "string") return null;
		if (!shouldIncludeContent(parseAssistantTextSignature(record.textSignature)?.phase ?? (hasExplicitPhasedTextBlocks ? void 0 : messagePhase))) return null;
		const sanitized = sanitizeBlockText(record.text);
		return sanitized.trim() ? sanitized : null;
	}).filter((value) => typeof value === "string");
	if (parts.length === 0) return;
	return normalizeJoinedText(parts.join(joinWith));
}
function extractAssistantVisibleText(message) {
	const finalAnswerText = extractAssistantTextForPhase(message, { phase: "final_answer" });
	if (finalAnswerText) return finalAnswerText;
	return extractAssistantTextForPhase(message);
}
//#endregion
export { normalizeAssistantPhase as a, resolveAssistantMessagePhase as c, extractFirstTextBlock as i, extractAssistantTextForPhase as n, parseAssistantTextSignature as o, extractAssistantVisibleText as r, resolveAssistantEventPhase as s, encodeAssistantTextSignature as t };
