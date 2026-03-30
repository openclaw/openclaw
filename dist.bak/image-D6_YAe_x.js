import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { d as isRecord } from "./utils-BKDT474X.js";
import { M as resolveAgentModelFallbackValues, N as resolveAgentModelPrimaryValue } from "./agent-scope-D8K2SjR7.js";
import { J as getApiKeyForModel, X as requireApiKey, qr as normalizeSecretInput } from "./model-selection-DILdVnl8.js";
import { t as ensureOpenClawModelsJson } from "./models-config-PcUiD3st.js";
import { n as discoverModels, t as discoverAuthStorage } from "./pi-model-discovery-CaAPcNJJ.js";
import { P as sanitizeUserFacingText } from "./pi-embedded-helpers-D_vwTcIu.js";
import { n as resolveToolDisplay, t as formatToolDetail } from "./tool-display-CERZKWmU.js";
import { complete } from "@mariozechner/pi-ai";

//#region src/agents/minimax-vlm.ts
function coerceApiHost(params) {
	const env = params.env ?? process.env;
	const raw = params.apiHost?.trim() || env.MINIMAX_API_HOST?.trim() || params.modelBaseUrl?.trim() || "https://api.minimax.io";
	try {
		return new URL(raw).origin;
	} catch {}
	try {
		return new URL(`https://${raw}`).origin;
	} catch {
		return "https://api.minimax.io";
	}
}
function pickString(rec, key) {
	const v = rec[key];
	return typeof v === "string" ? v : "";
}
async function minimaxUnderstandImage(params) {
	const apiKey = normalizeSecretInput(params.apiKey);
	if (!apiKey) throw new Error("MiniMax VLM: apiKey required");
	const prompt = params.prompt.trim();
	if (!prompt) throw new Error("MiniMax VLM: prompt required");
	const imageDataUrl = params.imageDataUrl.trim();
	if (!imageDataUrl) throw new Error("MiniMax VLM: imageDataUrl required");
	if (!/^data:image\/(png|jpeg|webp);base64,/i.test(imageDataUrl)) throw new Error("MiniMax VLM: imageDataUrl must be a base64 data:image/(png|jpeg|webp) URL");
	const host = coerceApiHost({
		apiHost: params.apiHost,
		modelBaseUrl: params.modelBaseUrl
	});
	const url = new URL("/v1/coding_plan/vlm", host).toString();
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"MM-API-Source": "OpenClaw"
		},
		body: JSON.stringify({
			prompt,
			image_url: imageDataUrl
		})
	});
	const traceId = res.headers.get("Trace-Id") ?? "";
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		const trace = traceId ? ` Trace-Id: ${traceId}` : "";
		throw new Error(`MiniMax VLM request failed (${res.status} ${res.statusText}).${trace}${body ? ` Body: ${body.slice(0, 400)}` : ""}`);
	}
	const json = await res.json().catch(() => null);
	if (!isRecord(json)) {
		const trace = traceId ? ` Trace-Id: ${traceId}` : "";
		throw new Error(`MiniMax VLM response was not JSON.${trace}`);
	}
	const baseResp = isRecord(json.base_resp) ? json.base_resp : {};
	const code = typeof baseResp.status_code === "number" ? baseResp.status_code : -1;
	if (code !== 0) {
		const msg = (baseResp.status_msg ?? "").trim();
		const trace = traceId ? ` Trace-Id: ${traceId}` : "";
		throw new Error(`MiniMax VLM API error (${code})${msg ? `: ${msg}` : ""}.${trace}`);
	}
	const content = pickString(json, "content").trim();
	if (!content) {
		const trace = traceId ? ` Trace-Id: ${traceId}` : "";
		throw new Error(`MiniMax VLM returned no content.${trace}`);
	}
	return content;
}

//#endregion
//#region src/shared/chat-content.ts
function extractTextFromChatContent(content, opts) {
	const normalize = opts?.normalizeText ?? ((text) => text.replace(/\s+/g, " ").trim());
	const joinWith = opts?.joinWith ?? " ";
	if (typeof content === "string") {
		const normalized = normalize(opts?.sanitizeText ? opts.sanitizeText(content) : content);
		return normalized ? normalized : null;
	}
	if (!Array.isArray(content)) return null;
	const chunks = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type !== "text") continue;
		const text = block.text;
		if (typeof text !== "string") continue;
		const value = opts?.sanitizeText ? opts.sanitizeText(text) : text;
		if (value.trim()) chunks.push(value);
	}
	const joined = normalize(chunks.join(joinWith));
	return joined ? joined : null;
}

//#endregion
//#region src/shared/text/code-regions.ts
function findCodeRegions(text) {
	const regions = [];
	for (const match of text.matchAll(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2(?:\n|$)|$)/g)) {
		const start = (match.index ?? 0) + match[1].length;
		regions.push({
			start,
			end: start + match[0].length - match[1].length
		});
	}
	for (const match of text.matchAll(/`+[^`]+`+/g)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (!regions.some((r) => start >= r.start && end <= r.end)) regions.push({
			start,
			end
		});
	}
	regions.sort((a, b) => a.start - b.start);
	return regions;
}
function isInsideCode(pos, regions) {
	return regions.some((r) => pos >= r.start && pos < r.end);
}

//#endregion
//#region src/shared/text/reasoning-tags.ts
const QUICK_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking|final)\b/i;
const FINAL_TAG_RE = /<\s*\/?\s*final\b[^<>]*>/gi;
const THINKING_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;
function applyTrim(value, mode) {
	if (mode === "none") return value;
	if (mode === "start") return value.trimStart();
	return value.trim();
}
function stripReasoningTagsFromText(text, options) {
	if (!text) return text;
	if (!QUICK_TAG_RE.test(text)) return text;
	const mode = options?.mode ?? "strict";
	const trimMode = options?.trim ?? "both";
	let cleaned = text;
	if (FINAL_TAG_RE.test(cleaned)) {
		FINAL_TAG_RE.lastIndex = 0;
		const finalMatches = [];
		const preCodeRegions = findCodeRegions(cleaned);
		for (const match of cleaned.matchAll(FINAL_TAG_RE)) {
			const start = match.index ?? 0;
			finalMatches.push({
				start,
				length: match[0].length,
				inCode: isInsideCode(start, preCodeRegions)
			});
		}
		for (let i = finalMatches.length - 1; i >= 0; i--) {
			const m = finalMatches[i];
			if (!m.inCode) cleaned = cleaned.slice(0, m.start) + cleaned.slice(m.start + m.length);
		}
	} else FINAL_TAG_RE.lastIndex = 0;
	const codeRegions = findCodeRegions(cleaned);
	THINKING_TAG_RE.lastIndex = 0;
	let result = "";
	let lastIndex = 0;
	let inThinking = false;
	for (const match of cleaned.matchAll(THINKING_TAG_RE)) {
		const idx = match.index ?? 0;
		const isClose = match[1] === "/";
		if (isInsideCode(idx, codeRegions)) continue;
		if (!inThinking) {
			result += cleaned.slice(lastIndex, idx);
			if (!isClose) inThinking = true;
		} else if (isClose) inThinking = false;
		lastIndex = idx + match[0].length;
	}
	if (!inThinking || mode === "preserve") result += cleaned.slice(lastIndex);
	return applyTrim(result, trimMode);
}

//#endregion
//#region src/agents/pi-embedded-utils.ts
function isAssistantMessage(msg) {
	return msg?.role === "assistant";
}
/**
* Strip malformed Minimax tool invocations that leak into text content.
* Minimax sometimes embeds tool calls as XML in text blocks instead of
* proper structured tool calls. This removes:
* - <invoke name="...">...</invoke> blocks
* - </minimax:tool_call> closing tags
*/
function stripMinimaxToolCallXml(text) {
	if (!text) return text;
	if (!/minimax:tool_call/i.test(text)) return text;
	let cleaned = text.replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "");
	cleaned = cleaned.replace(/<\/?minimax:tool_call>/gi, "");
	return cleaned;
}
/**
* Strip downgraded tool call text representations that leak into text content.
* When replaying history to Gemini, tool calls without `thought_signature` are
* downgraded to text blocks like `[Tool Call: name (ID: ...)]`. These should
* not be shown to users.
*/
function stripDowngradedToolCallText(text) {
	if (!text) return text;
	if (!/\[Tool (?:Call|Result)/i.test(text) && !/\[Historical context/i.test(text)) return text;
	const consumeJsonish = (input, start, options) => {
		const { allowLeadingNewlines = false } = options ?? {};
		let index = start;
		while (index < input.length) {
			const ch = input[index];
			if (ch === " " || ch === "	") {
				index += 1;
				continue;
			}
			if (allowLeadingNewlines && (ch === "\n" || ch === "\r")) {
				index += 1;
				continue;
			}
			break;
		}
		if (index >= input.length) return null;
		const startChar = input[index];
		if (startChar === "{" || startChar === "[") {
			let depth = 0;
			let inString = false;
			let escape = false;
			for (let i = index; i < input.length; i += 1) {
				const ch = input[i];
				if (inString) {
					if (escape) escape = false;
					else if (ch === "\\") escape = true;
					else if (ch === "\"") inString = false;
					continue;
				}
				if (ch === "\"") {
					inString = true;
					continue;
				}
				if (ch === "{" || ch === "[") {
					depth += 1;
					continue;
				}
				if (ch === "}" || ch === "]") {
					depth -= 1;
					if (depth === 0) return i + 1;
				}
			}
			return null;
		}
		if (startChar === "\"") {
			let escape = false;
			for (let i = index + 1; i < input.length; i += 1) {
				const ch = input[i];
				if (escape) {
					escape = false;
					continue;
				}
				if (ch === "\\") {
					escape = true;
					continue;
				}
				if (ch === "\"") return i + 1;
			}
			return null;
		}
		let end = index;
		while (end < input.length && input[end] !== "\n" && input[end] !== "\r") end += 1;
		return end;
	};
	const stripToolCalls = (input) => {
		const markerRe = /\[Tool Call:[^\]]*\]/gi;
		let result = "";
		let cursor = 0;
		for (const match of input.matchAll(markerRe)) {
			const start = match.index ?? 0;
			if (start < cursor) continue;
			result += input.slice(cursor, start);
			let index = start + match[0].length;
			while (index < input.length && (input[index] === " " || input[index] === "	")) index += 1;
			if (input[index] === "\r") {
				index += 1;
				if (input[index] === "\n") index += 1;
			} else if (input[index] === "\n") index += 1;
			while (index < input.length && (input[index] === " " || input[index] === "	")) index += 1;
			if (input.slice(index, index + 9).toLowerCase() === "arguments") {
				index += 9;
				if (input[index] === ":") index += 1;
				if (input[index] === " ") index += 1;
				const end = consumeJsonish(input, index, { allowLeadingNewlines: true });
				if (end !== null) index = end;
			}
			if ((input[index] === "\n" || input[index] === "\r") && (result.endsWith("\n") || result.endsWith("\r") || result.length === 0)) {
				if (input[index] === "\r") index += 1;
				if (input[index] === "\n") index += 1;
			}
			cursor = index;
		}
		result += input.slice(cursor);
		return result;
	};
	let cleaned = stripToolCalls(text);
	cleaned = cleaned.replace(/\[Tool Result for ID[^\]]*\]\n?[\s\S]*?(?=\n*\[Tool |\n*$)/gi, "");
	cleaned = cleaned.replace(/\[Historical context:[^\]]*\]\n?/gi, "");
	return cleaned.trim();
}
/**
* Strip thinking tags and their content from text.
* This is a safety net for cases where the model outputs <think> tags
* that slip through other filtering mechanisms.
*/
function stripThinkingTagsFromText(text) {
	return stripReasoningTagsFromText(text, {
		mode: "strict",
		trim: "both"
	});
}
function extractAssistantText(msg) {
	return sanitizeUserFacingText(extractTextFromChatContent(msg.content, {
		sanitizeText: (text) => stripThinkingTagsFromText(stripDowngradedToolCallText(stripMinimaxToolCallXml(text))).trim(),
		joinWith: "\n",
		normalizeText: (text) => text.trim()
	}) ?? "", { errorContext: msg.stopReason === "error" || Boolean(msg.errorMessage?.trim()) });
}
function extractAssistantThinking(msg) {
	if (!Array.isArray(msg.content)) return "";
	return msg.content.map((block) => {
		if (!block || typeof block !== "object") return "";
		const record = block;
		if (record.type === "thinking" && typeof record.thinking === "string") return record.thinking.trim();
		return "";
	}).filter(Boolean).join("\n").trim();
}
function formatReasoningMessage(text) {
	const trimmed = text.trim();
	if (!trimmed) return "";
	return `Reasoning:\n${trimmed.split("\n").map((line) => line ? `_${line}_` : line).join("\n")}`;
}
function splitThinkingTaggedText(text) {
	const trimmedStart = text.trimStart();
	if (!trimmedStart.startsWith("<")) return null;
	const openRe = /<\s*(?:think(?:ing)?|thought|antthinking)\s*>/i;
	const closeRe = /<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/i;
	if (!openRe.test(trimmedStart)) return null;
	if (!closeRe.test(text)) return null;
	const scanRe = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
	let inThinking = false;
	let cursor = 0;
	let thinkingStart = 0;
	const blocks = [];
	const pushText = (value) => {
		if (!value) return;
		blocks.push({
			type: "text",
			text: value
		});
	};
	const pushThinking = (value) => {
		const cleaned = value.trim();
		if (!cleaned) return;
		blocks.push({
			type: "thinking",
			thinking: cleaned
		});
	};
	for (const match of text.matchAll(scanRe)) {
		const index = match.index ?? 0;
		const isClose = Boolean(match[1]?.includes("/"));
		if (!inThinking && !isClose) {
			pushText(text.slice(cursor, index));
			thinkingStart = index + match[0].length;
			inThinking = true;
			continue;
		}
		if (inThinking && isClose) {
			pushThinking(text.slice(thinkingStart, index));
			cursor = index + match[0].length;
			inThinking = false;
		}
	}
	if (inThinking) return null;
	pushText(text.slice(cursor));
	if (!blocks.some((b) => b.type === "thinking")) return null;
	return blocks;
}
function promoteThinkingTagsToBlocks(message) {
	if (!Array.isArray(message.content)) return;
	if (message.content.some((block) => block.type === "thinking")) return;
	const next = [];
	let changed = false;
	for (const block of message.content) {
		if (block.type !== "text") {
			next.push(block);
			continue;
		}
		const split = splitThinkingTaggedText(block.text);
		if (!split) {
			next.push(block);
			continue;
		}
		changed = true;
		for (const part of split) if (part.type === "thinking") next.push({
			type: "thinking",
			thinking: part.thinking
		});
		else if (part.type === "text") {
			const cleaned = part.text.trimStart();
			if (cleaned) next.push({
				type: "text",
				text: cleaned
			});
		}
	}
	if (!changed) return;
	message.content = next;
}
function extractThinkingFromTaggedText(text) {
	if (!text) return "";
	const scanRe = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
	let result = "";
	let lastIndex = 0;
	let inThinking = false;
	for (const match of text.matchAll(scanRe)) {
		const idx = match.index ?? 0;
		if (inThinking) result += text.slice(lastIndex, idx);
		inThinking = !(match[1] === "/");
		lastIndex = idx + match[0].length;
	}
	return result.trim();
}
function extractThinkingFromTaggedStream(text) {
	if (!text) return "";
	const closed = extractThinkingFromTaggedText(text);
	if (closed) return closed;
	const openRe = /<\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
	const closeRe = /<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
	const openMatches = [...text.matchAll(openRe)];
	if (openMatches.length === 0) return "";
	const closeMatches = [...text.matchAll(closeRe)];
	const lastOpen = openMatches[openMatches.length - 1];
	const lastClose = closeMatches[closeMatches.length - 1];
	if (lastClose && (lastClose.index ?? -1) > (lastOpen.index ?? -1)) return closed;
	const start = (lastOpen.index ?? 0) + lastOpen[0].length;
	return text.slice(start).trim();
}
function inferToolMetaFromArgs(toolName, args) {
	return formatToolDetail(resolveToolDisplay({
		name: toolName,
		args
	}));
}

//#endregion
//#region src/agents/tools/image-tool.helpers.ts
function decodeDataUrl(dataUrl) {
	const trimmed = dataUrl.trim();
	const match = /^data:([^;,]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(trimmed);
	if (!match) throw new Error("Invalid data URL (expected base64 data: URL).");
	const mimeType = (match[1] ?? "").trim().toLowerCase();
	if (!mimeType.startsWith("image/")) throw new Error(`Unsupported data URL type: ${mimeType || "unknown"}`);
	const b64 = (match[2] ?? "").trim();
	const buffer = Buffer.from(b64, "base64");
	if (buffer.length === 0) throw new Error("Invalid data URL: empty payload.");
	return {
		buffer,
		mimeType,
		kind: "image"
	};
}
function coerceImageAssistantText(params) {
	const stop = params.message.stopReason;
	const errorMessage = params.message.errorMessage?.trim();
	if (stop === "error" || stop === "aborted") throw new Error(errorMessage ? `Image model failed (${params.provider}/${params.model}): ${errorMessage}` : `Image model failed (${params.provider}/${params.model})`);
	if (errorMessage) throw new Error(`Image model failed (${params.provider}/${params.model}): ${errorMessage}`);
	const text = extractAssistantText(params.message);
	if (text.trim()) return text.trim();
	throw new Error(`Image model returned no text (${params.provider}/${params.model}).`);
}
function coerceImageModelConfig(cfg) {
	const primary = resolveAgentModelPrimaryValue(cfg?.agents?.defaults?.imageModel);
	const fallbacks = resolveAgentModelFallbackValues(cfg?.agents?.defaults?.imageModel);
	return {
		...primary?.trim() ? { primary: primary.trim() } : {},
		...fallbacks.length > 0 ? { fallbacks } : {}
	};
}
function resolveProviderVisionModelFromConfig(params) {
	const models = (params.cfg?.models?.providers?.[params.provider])?.models ?? [];
	const id = (((params.provider === "minimax" ? models.find((m) => (m?.id ?? "").trim() === "MiniMax-VL-01" && Array.isArray(m?.input) && m.input.includes("image")) : null) ?? models.find((m) => Boolean((m?.id ?? "").trim()) && m.input?.includes("image")))?.id ?? "").trim();
	return id ? `${params.provider}/${id}` : null;
}

//#endregion
//#region src/media-understanding/providers/image.ts
var image_exports = /* @__PURE__ */ __exportAll({ describeImageWithModel: () => describeImageWithModel });
async function describeImageWithModel(params) {
	await ensureOpenClawModelsJson(params.cfg, params.agentDir);
	const authStorage = discoverAuthStorage(params.agentDir);
	const model = discoverModels(authStorage, params.agentDir).find(params.provider, params.model);
	if (!model) throw new Error(`Unknown model: ${params.provider}/${params.model}`);
	if (!model.input?.includes("image")) throw new Error(`Model does not support images: ${params.provider}/${params.model}`);
	const apiKey = requireApiKey(await getApiKeyForModel({
		model,
		cfg: params.cfg,
		agentDir: params.agentDir,
		profileId: params.profile,
		preferredProfile: params.preferredProfile
	}), model.provider);
	authStorage.setRuntimeApiKey(model.provider, apiKey);
	const base64 = params.buffer.toString("base64");
	if (model.provider === "minimax") return {
		text: await minimaxUnderstandImage({
			apiKey,
			prompt: params.prompt ?? "Describe the image.",
			imageDataUrl: `data:${params.mime ?? "image/jpeg"};base64,${base64}`,
			modelBaseUrl: model.baseUrl
		}),
		model: model.id
	};
	return {
		text: coerceImageAssistantText({
			message: await complete(model, { messages: [{
				role: "user",
				content: [{
					type: "text",
					text: params.prompt ?? "Describe the image."
				}, {
					type: "image",
					data: base64,
					mimeType: params.mime ?? "image/jpeg"
				}],
				timestamp: Date.now()
			}] }, {
				apiKey,
				maxTokens: params.maxTokens ?? 512
			}),
			provider: model.provider,
			model: model.id
		}),
		model: model.id
	};
}

//#endregion
export { minimaxUnderstandImage as S, stripThinkingTagsFromText as _, decodeDataUrl as a, isInsideCode as b, extractAssistantThinking as c, formatReasoningMessage as d, inferToolMetaFromArgs as f, stripMinimaxToolCallXml as g, stripDowngradedToolCallText as h, coerceImageModelConfig as i, extractThinkingFromTaggedStream as l, promoteThinkingTagsToBlocks as m, image_exports as n, resolveProviderVisionModelFromConfig as o, isAssistantMessage as p, coerceImageAssistantText as r, extractAssistantText as s, describeImageWithModel as t, extractThinkingFromTaggedText as u, stripReasoningTagsFromText as v, extractTextFromChatContent as x, findCodeRegions as y };