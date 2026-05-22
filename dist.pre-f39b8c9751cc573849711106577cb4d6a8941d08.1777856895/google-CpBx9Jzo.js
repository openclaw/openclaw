import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { y as truncateUtf16Safe } from "./utils-CCskKJVV.js";
import { n as sanitizeGoogleAssistantFirstOrdering, t as isGemma4ModelId } from "./google-models-xUuY5vSw.js";
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
const DEFAULT_BOOTSTRAP_PROMPT_TRUNCATION_WARNING_MODE = "once";
const MIN_BOOTSTRAP_FILE_BUDGET_CHARS = 64;
const BOOTSTRAP_HEAD_RATIO = .75;
const BOOTSTRAP_TAIL_RATIO = .25;
const MIN_BOOTSTRAP_TRIMMED_CONTENT_CHARS = 16;
function resolveBootstrapMaxChars(cfg) {
	const raw = cfg?.agents?.defaults?.bootstrapMaxChars;
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
	return DEFAULT_BOOTSTRAP_MAX_CHARS;
}
function resolveBootstrapTotalMaxChars(cfg) {
	const raw = cfg?.agents?.defaults?.bootstrapTotalMaxChars;
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
	return DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS;
}
function resolveBootstrapPromptTruncationWarningMode(cfg) {
	const raw = cfg?.agents?.defaults?.bootstrapPromptTruncationWarning;
	if (raw === "off" || raw === "once" || raw === "always") return raw;
	return DEFAULT_BOOTSTRAP_PROMPT_TRUNCATION_WARNING_MODE;
}
function trimBootstrapContent(content, fileName, maxChars) {
	const trimmed = content.trimEnd();
	if (trimmed.length <= maxChars) return {
		content: trimmed,
		truncated: false,
		maxChars,
		originalLength: trimmed.length
	};
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
function isGemma4ModelRequiringReasoningStrip(modelId) {
	return isGemma4ModelId(modelId);
}
//#endregion
export { resolveBootstrapMaxChars as a, sanitizeGoogleTurnOrdering as c, ensureSessionHeader as i, stripThoughtSignatures as l, isGoogleModelApi as n, resolveBootstrapPromptTruncationWarningMode as o, buildBootstrapContextFiles as r, resolveBootstrapTotalMaxChars as s, isGemma4ModelRequiringReasoningStrip as t };
