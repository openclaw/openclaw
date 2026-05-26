import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { y as truncateUtf16Safe } from "./utils-sBTEdeml.js";
import "./agent-scope-CtLXGcWm.js";
import { r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { p as normalizeThinkLevel } from "./thinking-DNSlsULp.js";
import "./sanitize-user-facing-text-Df1D-hzs.js";
import { n as sanitizeGoogleAssistantFirstOrdering } from "./google-models-C65oke3q.js";
import { v as isReasoningConstraintErrorMessage } from "./errors-DYND-qcd.js";
import { i as sanitizeToolCallIdsForCloudCodeAssist, n as extractToolResultId, t as extractToolCallsFromAssistant } from "./tool-call-id-CWG4BmeK.js";
import { t as sanitizeContentBlocksImages } from "./tool-images-Cv3ZnK02.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/agents/pi-embedded-helpers/bootstrap.ts
function isBase64Signature(value) {
	const trimmed = value.trim();
	if (!trimmed) return false;
	const compact = trimmed.replace(/\s+/g, "");
	if (!/^[A-Za-z0-9+/=_-]+$/.test(compact)) return false;
	const isUrl = compact.includes("-") || compact.includes("_");
	try {
		const buf = Buffer.from(compact, isUrl ? "base64url" : "base64");
		if (buf.length === 0) return false;
		const encoded = buf.toString(isUrl ? "base64url" : "base64");
		const normalize = (input) => input.replace(/=+$/g, "");
		return normalize(encoded) === normalize(compact);
	} catch {
		return false;
	}
}
/**
* Strips Claude-style thought_signature fields from content blocks.
*
* Gemini expects thought signatures as base64-encoded bytes, but Claude stores message ids
* like "msg_abc123...". We only strip "msg_*" to preserve any provider-valid signatures.
*/
function stripThoughtSignatures(content, options) {
	if (!Array.isArray(content)) return content;
	const allowBase64Only = options?.allowBase64Only ?? false;
	const includeCamelCase = options?.includeCamelCase ?? false;
	const shouldStripSignature = (value) => {
		if (!allowBase64Only) return typeof value === "string" && value.startsWith("msg_");
		return typeof value !== "string" || !isBase64Signature(value);
	};
	return content.map((block) => {
		if (!block || typeof block !== "object") return block;
		const rec = block;
		const stripSnake = shouldStripSignature(rec.thought_signature);
		const stripCamel = includeCamelCase ? shouldStripSignature(rec.thoughtSignature) : false;
		if (!stripSnake && !stripCamel) return block;
		const next = { ...rec };
		if (stripSnake) delete next.thought_signature;
		if (stripCamel) delete next.thoughtSignature;
		return next;
	});
}
const DEFAULT_BOOTSTRAP_MAX_CHARS = 12e3;
const DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS = 6e4;
const DEFAULT_BOOTSTRAP_PROMPT_TRUNCATION_WARNING_MODE = "always";
const MIN_BOOTSTRAP_FILE_BUDGET_CHARS = 64;
const BOOTSTRAP_HEAD_RATIO = .75;
const BOOTSTRAP_TAIL_RATIO = .25;
const MIN_BOOTSTRAP_TRIMMED_CONTENT_CHARS = 16;
const AGENTS_BOOTSTRAP_FILENAME = "AGENTS.md";
const AGENTS_POLICY_DIGEST_RATIO = .35;
const AGENTS_POLICY_HEAD_RATIO = .45;
const AGENTS_POLICY_TAIL_RATIO = .15;
const AGENTS_POLICY_DIGEST_MAX_LINE_CHARS = 240;
function resolveBootstrapMaxChars(cfg, agentId) {
	const raw = cfg && agentId ? resolveAgentConfig(cfg, agentId)?.bootstrapMaxChars ?? cfg.agents?.defaults?.bootstrapMaxChars : cfg?.agents?.defaults?.bootstrapMaxChars;
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
	return DEFAULT_BOOTSTRAP_MAX_CHARS;
}
function resolveBootstrapTotalMaxChars(cfg, agentId) {
	const raw = cfg && agentId ? resolveAgentConfig(cfg, agentId)?.bootstrapTotalMaxChars ?? cfg.agents?.defaults?.bootstrapTotalMaxChars : cfg?.agents?.defaults?.bootstrapTotalMaxChars;
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
	return DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS;
}
function resolveBootstrapPromptTruncationWarningMode(cfg) {
	const raw = cfg?.agents?.defaults?.bootstrapPromptTruncationWarning;
	if (raw === "off" || raw === "once" || raw === "always") return raw;
	return DEFAULT_BOOTSTRAP_PROMPT_TRUNCATION_WARNING_MODE;
}
function isAgentsBootstrapFile(fileName) {
	return fileName.toLowerCase() === AGENTS_BOOTSTRAP_FILENAME.toLowerCase();
}
function isPolicyDigestCandidate(line) {
	if (/^(?:#{1,6}|\s*[-*+]|\s*\d+[.)])\s+\S/u.test(line)) return true;
	return /\b(?:AGENTS\.md|scoped|required|must|never|do not|before subtree|read scoped|owner|security|secret|credential|test|validation|command|commit|push|github|pr)\b/iu.test(line);
}
function normalizePolicyDigestLine(line) {
	const normalized = line.trim().replace(/\s+/gu, " ");
	if (normalized.length <= AGENTS_POLICY_DIGEST_MAX_LINE_CHARS) return normalized;
	return `${truncateUtf16Safe(normalized, AGENTS_POLICY_DIGEST_MAX_LINE_CHARS - 1)}…`;
}
function buildAgentsPolicyDigest(content, budget) {
	if (budget <= 0) return {
		text: "",
		omittedLines: 0
	};
	const candidates = content.split(/\r?\n/u).map((line, index) => ({
		index,
		line: normalizePolicyDigestLine(line)
	})).filter(({ line }) => line.length > 0 && isPolicyDigestCandidate(line));
	const highPriorityPattern = /\b(?:AGENTS\.md|scoped|required|must|never|do not|before subtree|read scoped|security|secret|credential)\b/iu;
	const selected = /* @__PURE__ */ new Set();
	let used = 0;
	const trySelect = (candidate) => {
		const separatorChars = selected.size > 0 ? 1 : 0;
		if (used + separatorChars + candidate.line.length > budget) return;
		selected.add(candidate.index);
		used += separatorChars + candidate.line.length;
	};
	for (const candidate of candidates) if (highPriorityPattern.test(candidate.line)) trySelect(candidate);
	for (const candidate of candidates) if (!selected.has(candidate.index)) trySelect(candidate);
	const lines = candidates.filter((candidate) => selected.has(candidate.index)).toSorted((a, b) => a.index - b.index).map((candidate) => candidate.line);
	return {
		text: lines.join("\n"),
		omittedLines: Math.max(0, candidates.length - lines.length)
	};
}
function trimAgentsBootstrapContent(content, maxChars) {
	const trimmed = content.trimEnd();
	if (trimmed.length <= maxChars) return {
		content: trimmed,
		truncated: false,
		maxChars,
		originalLength: trimmed.length
	};
	let headChars = Math.floor(maxChars * AGENTS_POLICY_HEAD_RATIO);
	let tailChars = Math.floor(maxChars * AGENTS_POLICY_TAIL_RATIO);
	let digestBudget = Math.floor(maxChars * AGENTS_POLICY_DIGEST_RATIO);
	let digest = buildAgentsPolicyDigest(trimmed, digestBudget);
	const render = () => [
		trimmed.slice(0, headChars),
		`[...truncated, read ${AGENTS_BOOTSTRAP_FILENAME} for full content...]`,
		digest.text ? "[Policy digest from AGENTS.md]" : "",
		digest.text,
		digest.omittedLines > 0 ? `[...${digest.omittedLines} more policy lines omitted...]` : "",
		`…(truncated ${AGENTS_BOOTSTRAP_FILENAME}: kept ${headChars}+policy ${digest.text.length}+${tailChars} chars of ${trimmed.length})…`,
		tailChars > 0 ? trimmed.slice(-tailChars) : ""
	].filter((part) => part.length > 0).join("\n");
	let rendered = render();
	while (rendered.length > maxChars && (tailChars > 0 || headChars > 1 || digestBudget > 0)) {
		const overflow = rendered.length - maxChars;
		if (tailChars > 0) tailChars = Math.max(0, tailChars - overflow);
		else if (headChars > 1) headChars = Math.max(1, headChars - overflow);
		else {
			digestBudget = Math.max(0, digestBudget - overflow);
			digest = buildAgentsPolicyDigest(trimmed, digestBudget);
		}
		rendered = render();
	}
	return {
		content: rendered.length > maxChars ? truncateUtf16Safe(rendered, maxChars) : rendered,
		truncated: true,
		maxChars,
		originalLength: trimmed.length
	};
}
function trimBootstrapContent(content, fileName, maxChars) {
	const trimmed = content.trimEnd();
	if (trimmed.length <= maxChars) return {
		content: trimmed,
		truncated: false,
		maxChars,
		originalLength: trimmed.length
	};
	if (isAgentsBootstrapFile(fileName)) return trimAgentsBootstrapContent(content, maxChars);
	const markerTemplate = (headChars, tailChars) => [
		"",
		`[...truncated, read ${fileName} for full content...]`,
		`…(truncated ${fileName}: kept ${headChars}+${tailChars} chars of ${trimmed.length})…`,
		""
	].join("\n");
	const compactMarkerTemplate = (headChars, tailChars) => `[…truncated ${headChars}+${tailChars}/${trimmed.length}]`;
	const separatorCharsFor = (headCount, tailCount, markerContent) => markerContent.includes("\n") ? Number(headCount > 0) + Number(tailCount > 0) : 0;
	const renderTruncatedContent = (head, markerContent, tail) => [
		head,
		markerContent,
		tail
	].filter((part) => part.length > 0).join(markerContent.includes("\n") ? "\n" : "");
	const resolveMarkerTemplate = () => {
		const fullMarker = markerTemplate(0, 0);
		return maxChars - fullMarker.length - separatorCharsFor(1, 1, fullMarker) >= MIN_BOOTSTRAP_TRIMMED_CONTENT_CHARS ? markerTemplate : compactMarkerTemplate;
	};
	const resolvedMarkerTemplate = resolveMarkerTemplate();
	let headChars = 0;
	let tailChars = 0;
	let marker = resolvedMarkerTemplate(headChars, tailChars);
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const contentBudget = Math.max(0, maxChars - marker.length - separatorCharsFor(headChars, tailChars, marker));
		const nextHeadChars = Math.floor(contentBudget * BOOTSTRAP_HEAD_RATIO);
		const nextTailChars = Math.floor(contentBudget * BOOTSTRAP_TAIL_RATIO);
		const nextMarker = resolvedMarkerTemplate(nextHeadChars, nextTailChars);
		if (nextHeadChars === headChars && nextTailChars === tailChars && nextMarker.length === marker.length) break;
		headChars = nextHeadChars;
		tailChars = nextTailChars;
		marker = nextMarker;
	}
	let renderedLength = headChars + tailChars + marker.length + separatorCharsFor(headChars, tailChars, marker);
	while (renderedLength > maxChars && (tailChars > 0 || headChars > 0)) {
		const overflow = renderedLength - maxChars;
		if (tailChars > 0) tailChars = Math.max(0, tailChars - overflow);
		else headChars = Math.max(0, headChars - overflow);
		marker = resolvedMarkerTemplate(headChars, tailChars);
		renderedLength = headChars + tailChars + marker.length + separatorCharsFor(headChars, tailChars, marker);
	}
	if (headChars === 0 && tailChars === 0 && trimmed.length > 0) {
		const singleHeadMarker = resolvedMarkerTemplate(1, 0);
		if (1 + singleHeadMarker.length + separatorCharsFor(1, 0, singleHeadMarker) <= maxChars) {
			headChars = 1;
			marker = singleHeadMarker;
		}
	}
	const head = trimmed.slice(0, headChars);
	const tail = tailChars > 0 ? trimmed.slice(-tailChars) : "";
	const contentWithMarker = renderTruncatedContent(head, marker, tail);
	return {
		content: contentWithMarker.length > maxChars ? truncateUtf16Safe(contentWithMarker, maxChars) : contentWithMarker,
		truncated: true,
		maxChars,
		originalLength: trimmed.length
	};
}
function clampToBudget(content, budget) {
	if (budget <= 0) return "";
	if (content.length <= budget) return content;
	if (budget <= 3) return truncateUtf16Safe(content, budget);
	return `${truncateUtf16Safe(content, budget - 1)}…`;
}
async function ensureSessionHeader(params) {
	const file = params.sessionFile;
	try {
		await fs.stat(file);
		return;
	} catch {}
	await fs.mkdir(path.dirname(file), {
		recursive: true,
		mode: 448
	});
	const entry = {
		type: "session",
		version: 2,
		id: params.sessionId,
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		cwd: params.cwd
	};
	await fs.writeFile(file, `${JSON.stringify(entry)}\n`, {
		encoding: "utf-8",
		mode: 384
	});
}
function buildBootstrapContextFiles(files, opts) {
	const maxChars = opts?.maxChars ?? 12e3;
	let remainingTotalChars = Math.max(1, Math.floor(opts?.totalMaxChars ?? Math.max(maxChars, 6e4)));
	const result = [];
	for (const file of files) {
		if (remainingTotalChars <= 0) break;
		const pathValue = normalizeOptionalString(file.path) ?? "";
		if (!pathValue) {
			opts?.warn?.(`skipping bootstrap file "${file.name}" — missing or invalid "path" field (hook may have used "filePath" instead)`);
			continue;
		}
		if (file.missing) {
			const cappedMissingText = clampToBudget(`[MISSING] Expected at: ${pathValue}`, remainingTotalChars);
			if (!cappedMissingText) break;
			remainingTotalChars = Math.max(0, remainingTotalChars - cappedMissingText.length);
			result.push({
				path: pathValue,
				content: cappedMissingText
			});
			continue;
		}
		if (remainingTotalChars < MIN_BOOTSTRAP_FILE_BUDGET_CHARS) {
			opts?.warn?.(`remaining bootstrap budget is ${remainingTotalChars} chars (<${MIN_BOOTSTRAP_FILE_BUDGET_CHARS}); skipping additional bootstrap files`);
			break;
		}
		const fileMaxChars = Math.max(1, Math.min(maxChars, remainingTotalChars));
		const trimmed = trimBootstrapContent(file.content ?? "", file.name, fileMaxChars);
		const contentWithinBudget = clampToBudget(trimmed.content, remainingTotalChars);
		if (!contentWithinBudget) continue;
		if (trimmed.truncated || contentWithinBudget.length < trimmed.content.length) opts?.warn?.(`workspace bootstrap file ${file.name} is ${trimmed.originalLength} chars (limit ${trimmed.maxChars}); truncating in injected context`);
		remainingTotalChars = Math.max(0, remainingTotalChars - contentWithinBudget.length);
		result.push({
			path: pathValue,
			content: contentWithinBudget
		});
	}
	return result;
}
function sanitizeGoogleTurnOrdering(messages) {
	return sanitizeGoogleAssistantFirstOrdering(messages);
}
//#endregion
//#region src/agents/pi-embedded-helpers/google.ts
function isGoogleModelApi(api) {
	return api === "google-gemini-cli" || api === "google-generative-ai";
}
//#endregion
//#region src/agents/pi-embedded-helpers/openai.ts
function parseOpenAIReasoningSignature(value) {
	if (!value) return null;
	let candidate = null;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
		try {
			candidate = JSON.parse(trimmed);
		} catch {
			return null;
		}
	} else if (typeof value === "object") candidate = value;
	if (!candidate) return null;
	const id = typeof candidate.id === "string" ? candidate.id : "";
	const type = typeof candidate.type === "string" ? candidate.type : "";
	if (!id.startsWith("rs_")) return null;
	if (type === "reasoning" || type.startsWith("reasoning.")) return {
		id,
		type
	};
	return null;
}
function hasFollowingNonThinkingBlock(content, index) {
	for (let i = index + 1; i < content.length; i++) {
		const block = content[i];
		if (!block || typeof block !== "object") return true;
		if (block.type !== "thinking") return true;
	}
	return false;
}
function splitOpenAIFunctionCallPairing(id) {
	const separator = id.indexOf("|");
	if (separator <= 0 || separator >= id.length - 1) return { callId: id };
	return {
		callId: id.slice(0, separator),
		itemId: id.slice(separator + 1)
	};
}
function isOpenAIToolCallType(type) {
	return type === "toolCall" || type === "toolUse" || type === "functionCall";
}
/**
* OpenAI can reject replayed `function_call` items with an `fc_*` id if the
* matching `reasoning` item is absent in the same assistant turn.
*
* When that pairing is missing, strip the `|fc_*` suffix from tool call ids so
* pi-ai omits `function_call.id` on replay.
*/
function downgradeOpenAIFunctionCallReasoningPairs(messages) {
	let changed = false;
	const rewrittenMessages = [];
	let pendingRewrittenIds = null;
	for (const msg of messages) {
		if (!msg || typeof msg !== "object") {
			pendingRewrittenIds = null;
			rewrittenMessages.push(msg);
			continue;
		}
		const role = msg.role;
		if (role === "assistant") {
			const assistantMsg = msg;
			if (!Array.isArray(assistantMsg.content)) {
				pendingRewrittenIds = null;
				rewrittenMessages.push(msg);
				continue;
			}
			const localRewrittenIds = /* @__PURE__ */ new Map();
			let seenReplayableReasoning = false;
			let assistantChanged = false;
			const nextContent = assistantMsg.content.map((block) => {
				if (!block || typeof block !== "object") return block;
				const thinkingBlock = block;
				if (thinkingBlock.type === "thinking" && parseOpenAIReasoningSignature(thinkingBlock.thinkingSignature)) {
					seenReplayableReasoning = true;
					return block;
				}
				const toolCallBlock = block;
				if (!isOpenAIToolCallType(toolCallBlock.type) || typeof toolCallBlock.id !== "string") return block;
				const pairing = splitOpenAIFunctionCallPairing(toolCallBlock.id);
				if (seenReplayableReasoning || !pairing.itemId || !pairing.itemId.startsWith("fc_")) return block;
				assistantChanged = true;
				localRewrittenIds.set(toolCallBlock.id, pairing.callId);
				return {
					...block,
					id: pairing.callId
				};
			});
			pendingRewrittenIds = localRewrittenIds.size > 0 ? localRewrittenIds : null;
			if (!assistantChanged) {
				rewrittenMessages.push(msg);
				continue;
			}
			changed = true;
			rewrittenMessages.push({
				...assistantMsg,
				content: nextContent
			});
			continue;
		}
		if (role === "toolResult" && pendingRewrittenIds && pendingRewrittenIds.size > 0) {
			const toolResult = msg;
			let toolResultChanged = false;
			const updates = {};
			if (typeof toolResult.toolCallId === "string") {
				const nextToolCallId = pendingRewrittenIds.get(toolResult.toolCallId);
				if (nextToolCallId && nextToolCallId !== toolResult.toolCallId) {
					updates.toolCallId = nextToolCallId;
					toolResultChanged = true;
				}
			}
			if (typeof toolResult.toolUseId === "string") {
				const nextToolUseId = pendingRewrittenIds.get(toolResult.toolUseId);
				if (nextToolUseId && nextToolUseId !== toolResult.toolUseId) {
					updates.toolUseId = nextToolUseId;
					toolResultChanged = true;
				}
			}
			if (!toolResultChanged) {
				rewrittenMessages.push(msg);
				continue;
			}
			changed = true;
			rewrittenMessages.push({
				...toolResult,
				...updates
			});
			continue;
		}
		pendingRewrittenIds = null;
		rewrittenMessages.push(msg);
	}
	return changed ? rewrittenMessages : messages;
}
/**
* OpenAI Responses API can reject transcripts that contain a standalone `reasoning` item id
* without the required following item, or stale encrypted reasoning after a model route switch.
*
* OpenClaw persists provider-specific reasoning metadata in `thinkingSignature`; if that metadata
* is incomplete or no longer replay-safe, drop the block to keep history usable.
*/
function downgradeOpenAIReasoningBlocks(messages, options = {}) {
	let anyChanged = false;
	const out = [];
	for (const msg of messages) {
		if (!msg || typeof msg !== "object") {
			out.push(msg);
			continue;
		}
		if (msg.role !== "assistant") {
			out.push(msg);
			continue;
		}
		const assistantMsg = msg;
		if (!Array.isArray(assistantMsg.content)) {
			out.push(msg);
			continue;
		}
		let changed = false;
		const nextContent = [];
		for (let i = 0; i < assistantMsg.content.length; i++) {
			const block = assistantMsg.content[i];
			if (!block || typeof block !== "object") {
				nextContent.push(block);
				continue;
			}
			const record = block;
			if (record.type !== "thinking") {
				nextContent.push(block);
				continue;
			}
			if (!parseOpenAIReasoningSignature(record.thinkingSignature)) {
				nextContent.push(block);
				continue;
			}
			if (options.dropReplayableReasoning) {
				changed = true;
				continue;
			}
			if (hasFollowingNonThinkingBlock(assistantMsg.content, i)) {
				nextContent.push(block);
				continue;
			}
			changed = true;
		}
		if (!changed) {
			out.push(msg);
			continue;
		}
		anyChanged = true;
		if (nextContent.length === 0) continue;
		out.push({
			...assistantMsg,
			content: nextContent
		});
	}
	return anyChanged ? out : messages;
}
//#endregion
//#region src/agents/pi-embedded-helpers/images.ts
const EMPTY_CONTENT_PLACEHOLDER = "[empty content omitted]";
function dropEmptyTextBlocks(content) {
	return content.filter((block) => {
		if (!block || typeof block !== "object") return true;
		const rec = block;
		if (rec.type !== "text" || typeof rec.text !== "string") return true;
		return rec.text.trim().length > 0;
	});
}
function ensureNonEmptyContent(content) {
	if (content.length > 0) return content;
	return [{
		type: "text",
		text: EMPTY_CONTENT_PLACEHOLDER
	}];
}
async function sanitizeSessionMessagesImages(messages, label, options) {
	const allowNonImageSanitization = (options?.sanitizeMode ?? "full") === "full";
	const imageSanitization = {
		maxDimensionPx: options?.maxDimensionPx,
		maxBytes: options?.maxBytes
	};
	const sanitizedIds = options?.sanitizeToolCallIds === true ? sanitizeToolCallIdsForCloudCodeAssist(messages, options.toolCallIdMode, { preserveNativeAnthropicToolUseIds: options?.preserveNativeAnthropicToolUseIds }) : messages;
	const out = [];
	for (const msg of sanitizedIds) {
		if (!msg || typeof msg !== "object") {
			out.push(msg);
			continue;
		}
		const role = msg.role;
		if (role === "toolResult") {
			const toolMsg = msg;
			const nextContent = await sanitizeContentBlocksImages(Array.isArray(toolMsg.content) ? toolMsg.content : [], label, imageSanitization);
			out.push({
				...toolMsg,
				content: ensureNonEmptyContent(dropEmptyTextBlocks(nextContent))
			});
			continue;
		}
		if (role === "user") {
			const userMsg = msg;
			const content = userMsg.content;
			if (Array.isArray(content)) {
				const nextContent = await sanitizeContentBlocksImages(content, label, imageSanitization);
				out.push({
					...userMsg,
					content: ensureNonEmptyContent(dropEmptyTextBlocks(nextContent))
				});
				continue;
			}
		}
		if (role === "assistant") {
			const assistantMsg = msg;
			if (assistantMsg.stopReason === "error") {
				const content = assistantMsg.content;
				if (Array.isArray(content)) {
					const finalContent = dropEmptyTextBlocks(await sanitizeContentBlocksImages(content, label, imageSanitization));
					if (finalContent.length > 0) out.push({
						...assistantMsg,
						content: finalContent
					});
				} else out.push(assistantMsg);
				continue;
			}
			const content = assistantMsg.content;
			if (Array.isArray(content)) {
				const strippedContent = options?.preserveSignatures ? content : stripThoughtSignatures(content, options?.sanitizeThoughtSignatures);
				if (!allowNonImageSanitization) {
					const nextContent = await sanitizeContentBlocksImages(dropEmptyTextBlocks(strippedContent), label, imageSanitization);
					if (nextContent.length > 0) out.push({
						...assistantMsg,
						content: nextContent
					});
					continue;
				}
				const finalContent = await sanitizeContentBlocksImages(dropEmptyTextBlocks(strippedContent), label, imageSanitization);
				if (finalContent.length === 0) continue;
				out.push({
					...assistantMsg,
					content: finalContent
				});
				continue;
			}
		}
		out.push(msg);
	}
	return out;
}
//#endregion
//#region src/agents/pi-embedded-helpers/messaging-dedupe.ts
const MIN_DUPLICATE_TEXT_LENGTH = 10;
const MIN_REVERSE_SUBSTRING_DUPLICATE_RATIO = .5;
/**
* Normalize text for duplicate comparison.
* - Trims whitespace
* - Lowercases
* - Strips emoji (Emoji_Presentation and Extended_Pictographic)
* - Collapses multiple spaces to single space
*/
function normalizeTextForComparison(text) {
	return normalizeLowercaseStringOrEmpty(text).replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "").replace(/\s+/g, " ").trim();
}
function isMessagingToolDuplicateNormalized(normalized, normalizedSentTexts) {
	if (normalizedSentTexts.length === 0) return false;
	if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH) return false;
	return normalizedSentTexts.some((normalizedSent) => {
		if (!normalizedSent || normalizedSent.length < MIN_DUPLICATE_TEXT_LENGTH) return false;
		if (normalized.includes(normalizedSent)) return true;
		return normalizedSent.includes(normalized) && normalized.length >= normalizedSent.length * MIN_REVERSE_SUBSTRING_DUPLICATE_RATIO;
	});
}
function isMessagingToolDuplicate(text, sentTexts) {
	if (sentTexts.length === 0) return false;
	const normalized = normalizeTextForComparison(text);
	if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH) return false;
	return isMessagingToolDuplicateNormalized(normalized, sentTexts.map(normalizeTextForComparison));
}
//#endregion
//#region src/agents/pi-embedded-helpers/thinking.ts
function extractSupportedValues(raw) {
	const match = raw.match(/supported values are:\s*([^\n.]+)/i) ?? raw.match(/supported values:\s*([^\n.]+)/i);
	if (!match?.[1]) return [];
	const fragment = match[1];
	const quoted = Array.from(fragment.matchAll(/['"]([^'"]+)['"]/g)).map((entry) => entry[1]?.trim());
	if (quoted.length > 0) return quoted.filter((entry) => Boolean(entry));
	return fragment.split(/,|\band\b/gi).map((entry) => entry.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, "").trim()).filter(Boolean);
}
function pickFallbackThinkingLevel(params) {
	const raw = params.message?.trim();
	if (!raw) return;
	if (isReasoningConstraintErrorMessage(raw) && !params.attempted.has("minimal")) return "minimal";
	const supported = extractSupportedValues(raw);
	if (supported.length === 0) {
		if (/not supported/i.test(raw) && !params.attempted.has("off")) return "off";
		return;
	}
	for (const entry of supported) {
		const normalized = normalizeThinkLevel(entry);
		if (!normalized) continue;
		if (params.attempted.has(normalized)) continue;
		return normalized;
	}
}
//#endregion
//#region src/agents/pi-embedded-helpers/turns.ts
function isToolCallBlock(block) {
	return block.type === "toolUse" || block.type === "toolCall" || block.type === "functionCall";
}
function isThinkingLikeBlock(block) {
	if (!block || typeof block !== "object") return false;
	const type = block.type;
	return type === "thinking" || type === "redacted_thinking";
}
function isAbortedAssistantTurn(message) {
	const stopReason = message.stopReason;
	return stopReason === "aborted" || stopReason === "error";
}
function extractToolResultMatchIds(record) {
	const ids = /* @__PURE__ */ new Set();
	for (const value of [
		record.toolUseId,
		record.toolCallId,
		record.tool_use_id,
		record.tool_call_id,
		record.callId,
		record.call_id
	]) {
		const id = normalizeOptionalString(value);
		if (id) ids.add(id);
	}
	return ids;
}
function extractToolResultMatchName(record) {
	return normalizeOptionalString(record.toolName) ?? normalizeOptionalString(record.name) ?? null;
}
function collectAnyToolResultIds(message) {
	const ids = /* @__PURE__ */ new Set();
	const role = message.role;
	if (role === "toolResult") {
		const toolResultId = extractToolResultId(message);
		if (toolResultId) ids.add(toolResultId);
	} else if (role === "tool") {
		const record = message;
		for (const id of extractToolResultMatchIds(record)) ids.add(id);
	}
	const content = message.content;
	if (!Array.isArray(content)) return ids;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block;
		if (record.type !== "toolResult" && record.type !== "tool") continue;
		for (const id of extractToolResultMatchIds(record)) ids.add(id);
	}
	return ids;
}
function collectTrustedToolResultMatches(message) {
	const matches = /* @__PURE__ */ new Map();
	const role = message.role;
	const addMatch = (ids, toolName) => {
		for (const id of ids) {
			const bucket = matches.get(id) ?? /* @__PURE__ */ new Set();
			if (toolName) bucket.add(toolName);
			matches.set(id, bucket);
		}
	};
	if (role === "toolResult") {
		const record = message;
		addMatch([...extractToolResultMatchIds(record), ...(() => {
			const canonicalId = extractToolResultId(message);
			return canonicalId ? [canonicalId] : [];
		})()], extractToolResultMatchName(record));
	} else if (role === "tool") {
		const record = message;
		addMatch(extractToolResultMatchIds(record), extractToolResultMatchName(record));
	}
	return matches;
}
function collectFutureToolResultMatches(messages, startIndex) {
	const matches = /* @__PURE__ */ new Map();
	for (let index = startIndex + 1; index < messages.length; index += 1) {
		const candidate = messages[index];
		if (!candidate || typeof candidate !== "object") continue;
		if (candidate.role === "assistant") break;
		for (const [id, toolNames] of collectTrustedToolResultMatches(candidate)) {
			const bucket = matches.get(id) ?? /* @__PURE__ */ new Set();
			for (const toolName of toolNames) bucket.add(toolName);
			matches.set(id, bucket);
		}
	}
	return matches;
}
function collectFutureToolResultIds(messages, startIndex) {
	const ids = /* @__PURE__ */ new Set();
	for (let index = startIndex + 1; index < messages.length; index += 1) {
		const candidate = messages[index];
		if (!candidate || typeof candidate !== "object") continue;
		if (candidate.role === "assistant") break;
		for (const id of collectAnyToolResultIds(candidate)) ids.add(id);
	}
	return ids;
}
/**
* Strips dangling tool-call blocks from assistant messages when no later
* tool-result span before the next assistant turn resolves them.
* This fixes the "tool_use ids found without tool_result blocks" error from Anthropic.
*/
function stripDanglingAnthropicToolUses(messages) {
	const result = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg || typeof msg !== "object") {
			result.push(msg);
			continue;
		}
		if (msg.role !== "assistant") {
			result.push(msg);
			continue;
		}
		const assistantMsg = msg;
		const originalContent = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
		if (originalContent.length === 0) {
			result.push(msg);
			continue;
		}
		if (extractToolCallsFromAssistant(msg).length === 0) {
			result.push(msg);
			continue;
		}
		const hasThinking = originalContent.some((block) => isThinkingLikeBlock(block));
		const validToolResultMatches = collectFutureToolResultMatches(messages, i);
		const validToolUseIds = collectFutureToolResultIds(messages, i);
		if (hasThinking) {
			if (originalContent.every((block) => {
				if (!block || !isToolCallBlock(block)) return true;
				const blockId = normalizeOptionalString(block.id);
				const blockName = normalizeOptionalString(block.name);
				if (!blockId || !blockName) return false;
				const matchingToolNames = validToolResultMatches.get(blockId);
				if (!matchingToolNames) return false;
				return matchingToolNames.size === 0 || matchingToolNames.has(blockName);
			})) result.push(msg);
			else result.push({
				...assistantMsg,
				content: isAbortedAssistantTurn(msg) ? [] : [{
					type: "text",
					text: "[tool calls omitted]"
				}]
			});
			continue;
		}
		const filteredContent = originalContent.filter((block) => {
			if (!block) return false;
			if (!isToolCallBlock(block)) return true;
			const blockId = normalizeOptionalString(block.id);
			return blockId ? validToolUseIds.has(blockId) : false;
		});
		if (filteredContent.length === originalContent.length) {
			result.push(msg);
			continue;
		}
		if (originalContent.length > 0 && filteredContent.length === 0) result.push({
			...assistantMsg,
			content: isAbortedAssistantTurn(msg) ? [] : [{
				type: "text",
				text: "[tool calls omitted]"
			}]
		});
		else result.push({
			...assistantMsg,
			content: filteredContent
		});
	}
	return result;
}
function validateTurnsWithConsecutiveMerge(params) {
	const { messages, role, merge } = params;
	if (!Array.isArray(messages) || messages.length === 0) return messages;
	const result = [];
	let lastRole;
	for (const msg of messages) {
		if (!msg || typeof msg !== "object") {
			result.push(msg);
			continue;
		}
		const msgRole = msg.role;
		if (!msgRole) {
			result.push(msg);
			continue;
		}
		if (msgRole === lastRole && lastRole === role) {
			const lastMsg = result[result.length - 1];
			const currentMsg = msg;
			if (lastMsg && typeof lastMsg === "object") {
				const lastTyped = lastMsg;
				result[result.length - 1] = merge(lastTyped, currentMsg);
				continue;
			}
		}
		result.push(msg);
		lastRole = msgRole;
	}
	return result;
}
function mergeConsecutiveAssistantTurns(previous, current) {
	const mergedContent = [...Array.isArray(previous.content) ? previous.content : [], ...Array.isArray(current.content) ? current.content : []];
	return {
		...previous,
		content: mergedContent,
		...current.usage && { usage: current.usage },
		...current.stopReason && { stopReason: current.stopReason },
		...current.errorMessage && { errorMessage: current.errorMessage }
	};
}
/**
* Validates and fixes conversation turn sequences for Gemini API.
* Gemini requires strict alternating user→assistant→tool→user pattern.
* Merges consecutive assistant messages together.
*/
function validateGeminiTurns(messages) {
	return validateTurnsWithConsecutiveMerge({
		messages,
		role: "assistant",
		merge: mergeConsecutiveAssistantTurns
	});
}
function mergeConsecutiveUserTurns(previous, current) {
	const mergedContent = [...normalizeUserContentForMerge(previous.content), ...normalizeUserContentForMerge(current.content)];
	return {
		...current,
		content: mergedContent,
		timestamp: current.timestamp ?? previous.timestamp
	};
}
function normalizeUserContentForMerge(content) {
	if (Array.isArray(content)) return content;
	if (typeof content === "string") return [{
		type: "text",
		text: content
	}];
	return [];
}
/**
* Validates and fixes conversation turn sequences for Anthropic API.
* Anthropic requires strict alternating user→assistant pattern.
* Merges consecutive user messages together.
* Also strips dangling tool_use blocks that lack corresponding tool_result blocks.
*/
function validateAnthropicTurns(messages) {
	return validateTurnsWithConsecutiveMerge({
		messages: stripDanglingAnthropicToolUses(messages),
		role: "user",
		merge: mergeConsecutiveUserTurns
	});
}
//#endregion
export { resolveBootstrapMaxChars as _, isMessagingToolDuplicate as a, sanitizeGoogleTurnOrdering as b, sanitizeSessionMessagesImages as c, isGoogleModelApi as d, DEFAULT_BOOTSTRAP_MAX_CHARS as f, ensureSessionHeader as g, buildBootstrapContextFiles as h, pickFallbackThinkingLevel as i, downgradeOpenAIFunctionCallReasoningPairs as l, DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS as m, validateAnthropicTurns as n, isMessagingToolDuplicateNormalized as o, DEFAULT_BOOTSTRAP_PROMPT_TRUNCATION_WARNING_MODE as p, validateGeminiTurns as r, normalizeTextForComparison as s, mergeConsecutiveUserTurns as t, downgradeOpenAIReasoningBlocks as u, resolveBootstrapPromptTruncationWarningMode as v, stripThoughtSignatures as x, resolveBootstrapTotalMaxChars as y };
