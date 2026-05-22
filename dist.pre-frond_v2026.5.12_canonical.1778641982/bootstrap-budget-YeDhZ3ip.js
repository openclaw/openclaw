import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import path from "node:path";
//#region src/agents/bootstrap-budget.ts
const DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO = .85;
const DEFAULT_BOOTSTRAP_PROMPT_WARNING_MAX_FILES = 3;
const DEFAULT_BOOTSTRAP_PROMPT_WARNING_SIGNATURE_HISTORY_MAX = 32;
function normalizePositiveLimit(value) {
	if (!Number.isFinite(value) || value <= 0) return 1;
	return Math.floor(value);
}
function formatWarningCause(cause) {
	return cause === "per-file-limit" ? "max/file" : "max/total";
}
function normalizeSeenSignatures(signatures) {
	if (!Array.isArray(signatures) || signatures.length === 0) return [];
	const seen = /* @__PURE__ */ new Set();
	const result = [];
	for (const signature of signatures) {
		const value = normalizeOptionalString(signature) ?? "";
		if (!value || seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}
function appendSeenSignature(signatures, signature) {
	if (!signature.trim()) return signatures;
	if (signatures.includes(signature)) return signatures;
	const next = [...signatures, signature];
	if (next.length <= DEFAULT_BOOTSTRAP_PROMPT_WARNING_SIGNATURE_HISTORY_MAX) return next;
	return next.slice(-DEFAULT_BOOTSTRAP_PROMPT_WARNING_SIGNATURE_HISTORY_MAX);
}
function resolveBootstrapWarningSignaturesSeen(report) {
	const truncation = report?.bootstrapTruncation;
	const seenFromReport = normalizeSeenSignatures(truncation?.warningSignaturesSeen);
	if (seenFromReport.length > 0) return seenFromReport;
	if (truncation?.warningMode === "off") return [];
	const single = typeof truncation?.promptWarningSignature === "string" ? normalizeOptionalString(truncation.promptWarningSignature) ?? "" : "";
	return single ? [single] : [];
}
function buildBootstrapInjectionStats(params) {
	const injectedByPath = /* @__PURE__ */ new Map();
	const injectedByBaseName = /* @__PURE__ */ new Map();
	for (const file of params.injectedFiles) {
		const pathValue = normalizeOptionalString(file.path) ?? "";
		if (!pathValue) continue;
		if (!injectedByPath.has(pathValue)) injectedByPath.set(pathValue, file.content);
		const normalizedPath = pathValue.replace(/\\/g, "/");
		const baseName = path.posix.basename(normalizedPath);
		if (!injectedByBaseName.has(baseName)) injectedByBaseName.set(baseName, file.content);
	}
	return params.bootstrapFiles.map((file) => {
		const pathValue = normalizeOptionalString(file.path) ?? "";
		const rawChars = file.missing ? 0 : (file.content ?? "").trimEnd().length;
		const injected = (pathValue ? injectedByPath.get(pathValue) : void 0) ?? injectedByPath.get(file.name) ?? injectedByBaseName.get(file.name);
		const injectedChars = injected ? injected.length : 0;
		const truncated = !file.missing && injectedChars < rawChars;
		return {
			name: file.name,
			path: pathValue || file.name,
			missing: file.missing,
			rawChars,
			injectedChars,
			truncated
		};
	});
}
function analyzeBootstrapBudget(params) {
	const bootstrapMaxChars = normalizePositiveLimit(params.bootstrapMaxChars);
	const bootstrapTotalMaxChars = normalizePositiveLimit(params.bootstrapTotalMaxChars);
	const nearLimitRatio = typeof params.nearLimitRatio === "number" && Number.isFinite(params.nearLimitRatio) && params.nearLimitRatio > 0 && params.nearLimitRatio < 1 ? params.nearLimitRatio : DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO;
	const nonMissing = params.files.filter((file) => !file.missing);
	const rawChars = nonMissing.reduce((sum, file) => sum + file.rawChars, 0);
	const injectedChars = nonMissing.reduce((sum, file) => sum + file.injectedChars, 0);
	const totalNearLimit = injectedChars >= Math.ceil(bootstrapTotalMaxChars * nearLimitRatio);
	const totalOverLimit = injectedChars >= bootstrapTotalMaxChars;
	const files = params.files.map((file) => {
		if (file.missing) return {
			...file,
			nearLimit: false,
			causes: []
		};
		const perFileOverLimit = file.rawChars > bootstrapMaxChars;
		const nearLimit = file.rawChars >= Math.ceil(bootstrapMaxChars * nearLimitRatio);
		const causes = [];
		if (file.truncated) {
			if (perFileOverLimit) causes.push("per-file-limit");
			if (totalOverLimit) causes.push("total-limit");
		}
		return {
			...file,
			nearLimit,
			causes
		};
	});
	const truncatedFiles = files.filter((file) => file.truncated);
	return {
		files,
		truncatedFiles,
		nearLimitFiles: files.filter((file) => file.nearLimit),
		totalNearLimit,
		hasTruncation: truncatedFiles.length > 0,
		totals: {
			rawChars,
			injectedChars,
			truncatedChars: Math.max(0, rawChars - injectedChars),
			bootstrapMaxChars,
			bootstrapTotalMaxChars,
			nearLimitRatio
		}
	};
}
function buildBootstrapTruncationSignature(analysis) {
	if (!analysis.hasTruncation) return;
	const files = analysis.truncatedFiles.map((file) => ({
		path: file.path || file.name,
		rawChars: file.rawChars,
		injectedChars: file.injectedChars,
		causes: [...file.causes].toSorted()
	})).toSorted((a, b) => {
		const pathCmp = a.path.localeCompare(b.path);
		if (pathCmp !== 0) return pathCmp;
		if (a.rawChars !== b.rawChars) return a.rawChars - b.rawChars;
		if (a.injectedChars !== b.injectedChars) return a.injectedChars - b.injectedChars;
		return a.causes.join("+").localeCompare(b.causes.join("+"));
	});
	return JSON.stringify({
		bootstrapMaxChars: analysis.totals.bootstrapMaxChars,
		bootstrapTotalMaxChars: analysis.totals.bootstrapTotalMaxChars,
		files
	});
}
function formatBootstrapTruncationWarningLines(params) {
	if (!params.analysis.hasTruncation) return [];
	const maxFiles = typeof params.maxFiles === "number" && Number.isFinite(params.maxFiles) && params.maxFiles > 0 ? Math.floor(params.maxFiles) : DEFAULT_BOOTSTRAP_PROMPT_WARNING_MAX_FILES;
	const lines = [];
	const duplicateNameCounts = params.analysis.truncatedFiles.reduce((acc, file) => {
		acc.set(file.name, (acc.get(file.name) ?? 0) + 1);
		return acc;
	}, /* @__PURE__ */ new Map());
	const topFiles = params.analysis.truncatedFiles.slice(0, maxFiles);
	for (const file of topFiles) {
		const pct = file.rawChars > 0 ? Math.round((file.rawChars - file.injectedChars) / file.rawChars * 100) : 0;
		const causeText = file.causes.length > 0 ? file.causes.map((cause) => formatWarningCause(cause)).join(", ") : "";
		const nameLabel = (duplicateNameCounts.get(file.name) ?? 0) > 1 && file.path.trim().length > 0 ? `${file.name} (${file.path})` : file.name;
		lines.push(`${nameLabel}: ${file.rawChars} raw -> ${file.injectedChars} injected (~${Math.max(0, pct)}% removed${causeText ? `; ${causeText}` : ""}).`);
	}
	if (params.analysis.truncatedFiles.length > topFiles.length) lines.push(`+${params.analysis.truncatedFiles.length - topFiles.length} more truncated file(s).`);
	lines.push("If unintentional, raise agents.defaults.bootstrapMaxChars and/or agents.defaults.bootstrapTotalMaxChars.");
	return lines;
}
function buildBootstrapPromptWarning(params) {
	const signature = buildBootstrapTruncationSignature(params.analysis);
	let seenSignatures = normalizeSeenSignatures(params.seenSignatures);
	if (params.previousSignature && !seenSignatures.includes(params.previousSignature)) seenSignatures = appendSeenSignature(seenSignatures, params.previousSignature);
	const hasSeenSignature = Boolean(signature && seenSignatures.includes(signature));
	const warningShown = params.mode !== "off" && Boolean(signature) && (params.mode === "always" || !hasSeenSignature);
	const warningSignaturesSeen = signature && params.mode !== "off" ? appendSeenSignature(seenSignatures, signature) : seenSignatures;
	return {
		signature,
		warningShown,
		lines: warningShown ? formatBootstrapTruncationWarningLines({
			analysis: params.analysis,
			maxFiles: params.maxFiles
		}) : [],
		warningSignaturesSeen
	};
}
function appendBootstrapPromptWarning(prompt, warningLines, options) {
	const normalizedLines = (warningLines ?? []).map((line) => line.trim()).filter(Boolean);
	if (normalizedLines.length === 0) return prompt;
	if (options?.preserveExactPrompt && prompt === options.preserveExactPrompt) return prompt;
	const warningBlock = [
		"[Bootstrap truncation warning]",
		"Some workspace bootstrap files were truncated before injection.",
		"Treat Project Context as partial and read the relevant files directly if details seem missing.",
		...normalizedLines.map((line) => `- ${line}`)
	].join("\n");
	return prompt ? `${prompt}\n\n${warningBlock}` : warningBlock;
}
function buildBootstrapPromptWarningNotice(warningLines) {
	if (!(warningLines ?? []).some((line) => line.trim().length > 0)) return;
	return [
		"[Bootstrap truncation warning]",
		"Some workspace bootstrap files were truncated before Project Context injection.",
		"Treat Project Context as partial and read the relevant files directly if details seem missing."
	].join("\n");
}
function buildBootstrapTruncationReportMeta(params) {
	return {
		warningMode: params.warningMode,
		warningShown: params.warning.warningShown,
		promptWarningSignature: params.warning.signature,
		...params.warning.warningSignaturesSeen.length > 0 ? { warningSignaturesSeen: params.warning.warningSignaturesSeen } : {},
		truncatedFiles: params.analysis.truncatedFiles.length,
		nearLimitFiles: params.analysis.nearLimitFiles.length,
		totalNearLimit: params.analysis.totalNearLimit
	};
}
//#endregion
export { buildBootstrapPromptWarningNotice as a, buildBootstrapPromptWarning as i, appendBootstrapPromptWarning as n, buildBootstrapTruncationReportMeta as o, buildBootstrapInjectionStats as r, resolveBootstrapWarningSignaturesSeen as s, analyzeBootstrapBudget as t };
