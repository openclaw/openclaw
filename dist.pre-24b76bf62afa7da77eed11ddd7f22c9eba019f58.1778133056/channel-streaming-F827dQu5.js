import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { r as resolveToolDisplay, t as formatToolDetail } from "./tool-display-CNHDPzD2.js";
import { t as formatToolAggregate } from "./tool-meta-CvuWS6d6.js";
//#region src/plugin-sdk/channel-streaming.ts
function asObjectRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function asTextChunkMode(value) {
	return value === "length" || value === "newline" ? value : void 0;
}
function asBoolean(value) {
	return typeof value === "boolean" ? value : void 0;
}
function asInteger(value) {
	return typeof value === "number" && Number.isInteger(value) ? value : void 0;
}
function normalizeStreamingMode(value) {
	if (typeof value !== "string") return null;
	return normalizeOptionalLowercaseString(value) || null;
}
function parsePreviewStreamingMode(value) {
	const normalized = normalizeStreamingMode(value);
	if (normalized === "off" || normalized === "partial" || normalized === "block" || normalized === "progress") return normalized;
	return null;
}
function asBlockStreamingCoalesceConfig(value) {
	return asObjectRecord(value);
}
function asBlockStreamingChunkConfig(value) {
	return asObjectRecord(value);
}
function asProgressConfig(value) {
	return asObjectRecord(value);
}
function asCommandTextMode(value) {
	return value === "raw" || value === "status" ? value : void 0;
}
const DEFAULT_PROGRESS_DRAFT_LABELS = [
	"Thinking...",
	"Shelling...",
	"Scuttling...",
	"Clawing...",
	"Pinching...",
	"Molting...",
	"Bubbling...",
	"Tiding...",
	"Reefing...",
	"Cracking...",
	"Sifting...",
	"Brining...",
	"Nautiling...",
	"Krilling...",
	"Barnacling...",
	"Lobstering...",
	"Tidepooling...",
	"Pearling...",
	"Snapping...",
	"Surfacing..."
];
const DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS = 5e3;
const DEFAULT_PROGRESS_DRAFT_MAX_LINE_CHARS = 72;
const NON_WORK_PROGRESS_TOOL_NAMES = new Set([
	"message",
	"messages",
	"reply",
	"send",
	"reaction",
	"react",
	"typing"
]);
function isChannelProgressDraftWorkToolName(name) {
	const normalized = normalizeOptionalLowercaseString(name);
	return Boolean(normalized && !NON_WORK_PROGRESS_TOOL_NAMES.has(normalized));
}
const EMOJI_PREFIX_RE = /^\p{Extended_Pictographic}/u;
function compactStrings(values) {
	return values.map((value) => value?.replace(/\s+/g, " ").trim()).filter(Boolean);
}
function inferToolMeta(name, args, detailMode = "explain") {
	if (!name || !args) return;
	return formatToolDetail(resolveToolDisplay({
		name,
		args,
		detailMode
	}));
}
function buildNamedProgressLine(kind, name, metas, options, fields) {
	const normalizedName = name?.trim() || "tool_call";
	const compactMetas = compactStrings(metas ?? []);
	const text = formatToolAggregate(normalizedName, compactMetas.length ? compactMetas : void 0, { markdown: options?.markdown });
	const display = resolveToolDisplay({ name: normalizedName });
	const prefix = `${display.emoji} ${display.label}`;
	const detail = text.startsWith(`${prefix}: `) ? text.slice(prefix.length + 2).trim() : void 0;
	return {
		kind,
		text,
		label: display.label,
		icon: display.emoji,
		...detail ? { detail } : {},
		...fields?.status ? { status: fields.status } : {},
		toolName: display.name
	};
}
function itemKindToToolName(kind) {
	switch (normalizeOptionalLowercaseString(kind)) {
		case "command": return "exec";
		case "patch": return "apply_patch";
		case "search": return "web_search";
		case "tool": return "tool_call";
		default: return;
	}
}
function isCommandToolName(name) {
	const normalized = normalizeOptionalLowercaseString(name);
	return normalized === "exec" || normalized === "shell" || normalized === "bash";
}
function isCommandProgressItem(input) {
	return normalizeOptionalLowercaseString(input.itemKind) === "command" || isCommandToolName(input.name);
}
function patchMetas(input) {
	const fileMetas = [
		...input.added ?? [],
		...input.modified ?? [],
		...input.deleted ?? []
	];
	return compactStrings([
		input.summary,
		...fileMetas,
		input.title
	]);
}
function shouldPrefixProgressLine(line) {
	return !EMOJI_PREFIX_RE.test(line);
}
function formatChannelProgressDraftLine(input, options) {
	return buildChannelProgressDraftLine(input, options)?.text;
}
function resolveChannelProgressDraftLineOptions(entry, options) {
	return {
		...options,
		commandText: options?.commandText ?? resolveChannelStreamingPreviewCommandText(entry)
	};
}
function buildChannelProgressDraftLineForEntry(entry, input, options) {
	return buildChannelProgressDraftLine(input, resolveChannelProgressDraftLineOptions(entry, options));
}
function formatChannelProgressDraftLineForEntry(entry, input, options) {
	return buildChannelProgressDraftLineForEntry(entry, input, options)?.text;
}
function buildChannelProgressDraftLine(input, options) {
	switch (input.event) {
		case "tool": return buildNamedProgressLine(input.event, input.name, [options?.commandText === "status" && isCommandToolName(input.name) ? void 0 : inferToolMeta(input.name, input.args, options?.detailMode), input.phase && !input.name ? input.phase : void 0], options);
		case "item": {
			const name = input.name ?? itemKindToToolName(input.itemKind);
			const meta = input.meta ?? input.summary ?? (options?.commandText === "status" && isCommandProgressItem(input) ? void 0 : input.progressText);
			if (name) return buildNamedProgressLine(input.event, name, [meta], options, { status: input.status });
			const text = compactStrings([meta, input.title]).at(0);
			return text ? {
				kind: input.event,
				text,
				label: input.title?.trim() || input.itemKind?.trim() || "Update",
				...input.status ? { status: input.status } : {}
			} : void 0;
		}
		case "plan":
			if (input.phase !== void 0 && input.phase !== "update") return;
			return buildNamedProgressLine(input.event, "update_plan", [
				input.explanation,
				input.steps?.[0],
				input.title ?? "planning"
			], options);
		case "approval":
			if (input.phase !== void 0 && input.phase !== "requested") return;
			return buildNamedProgressLine(input.event, "approval", [
				input.command,
				input.message,
				input.reason,
				input.title ?? "approval requested"
			], options, { status: "requested" });
		case "command-output": {
			if (input.phase !== void 0 && input.phase !== "end") return;
			const status = input.exitCode === 0 ? "completed" : input.exitCode != null ? `exit ${input.exitCode}` : input.status;
			return buildNamedProgressLine(input.event, input.name ?? "exec", [status, input.title], options, { status });
		}
		case "patch":
			if (input.phase !== void 0 && input.phase !== "end") return;
			return buildNamedProgressLine(input.event, input.name ?? "apply_patch", patchMetas(input), options);
	}
}
function createChannelProgressDraftGate(params) {
	const initialDelayMs = params.initialDelayMs ?? 5e3;
	const setTimeoutFn = params.setTimeoutFn ?? setTimeout;
	const clearTimeoutFn = params.clearTimeoutFn ?? clearTimeout;
	let started = false;
	let disposed = false;
	let workEvents = 0;
	let timer;
	let startPromise;
	const clearTimer = () => {
		if (timer) {
			clearTimeoutFn(timer);
			timer = void 0;
		}
	};
	const start = () => {
		if (disposed || started) return startPromise ?? Promise.resolve();
		started = true;
		clearTimer();
		startPromise = Promise.resolve().then(params.onStart);
		return startPromise;
	};
	const schedule = () => {
		if (timer || started || disposed || initialDelayMs < 0) return;
		timer = setTimeoutFn(() => {
			timer = void 0;
			start().catch(() => {});
		}, initialDelayMs);
	};
	return {
		get hasStarted() {
			return started;
		},
		get workEvents() {
			return workEvents;
		},
		async noteWork() {
			if (disposed) return false;
			workEvents += 1;
			if (started) return true;
			if (workEvents > 1) {
				await start();
				return true;
			}
			schedule();
			return false;
		},
		async startNow() {
			await start();
		},
		cancel() {
			disposed = true;
			clearTimer();
		}
	};
}
function getChannelStreamingConfigObject(entry) {
	const streaming = asObjectRecord(entry?.streaming);
	return streaming ? streaming : void 0;
}
function resolveChannelStreamingChunkMode(entry) {
	return asTextChunkMode(getChannelStreamingConfigObject(entry)?.chunkMode) ?? asTextChunkMode(entry?.chunkMode);
}
function resolveChannelStreamingBlockEnabled(entry) {
	return asBoolean(getChannelStreamingConfigObject(entry)?.block?.enabled) ?? asBoolean(entry?.blockStreaming);
}
function resolveChannelStreamingBlockCoalesce(entry) {
	return asBlockStreamingCoalesceConfig(getChannelStreamingConfigObject(entry)?.block?.coalesce) ?? asBlockStreamingCoalesceConfig(entry?.blockStreamingCoalesce);
}
function resolveChannelStreamingPreviewChunk(entry) {
	return asBlockStreamingChunkConfig(getChannelStreamingConfigObject(entry)?.preview?.chunk) ?? asBlockStreamingChunkConfig(entry?.draftChunk);
}
function resolveChannelStreamingPreviewToolProgress(entry, defaultValue = true) {
	const config = getChannelStreamingConfigObject(entry);
	if (resolveChannelPreviewStreamMode(entry, "partial") === "progress") return asBoolean(config?.progress?.toolProgress) ?? asBoolean(config?.preview?.toolProgress) ?? defaultValue;
	return asBoolean(config?.preview?.toolProgress) ?? defaultValue;
}
function resolveChannelStreamingPreviewCommandText(entry, defaultValue = "raw") {
	const config = getChannelStreamingConfigObject(entry);
	return asCommandTextMode(config?.progress?.commandText) ?? asCommandTextMode(config?.preview?.commandText) ?? defaultValue;
}
function resolveChannelStreamingSuppressDefaultToolProgressMessages(entry, options) {
	if (options?.draftStreamActive === false || options?.previewStreamingEnabled === false) return false;
	const mode = resolveChannelPreviewStreamMode(entry, "off");
	if (mode === "off") return false;
	if (mode === "progress") return true;
	if (options?.draftStreamActive === true) return true;
	return options?.previewToolProgressEnabled ?? resolveChannelStreamingPreviewToolProgress(entry);
}
function resolveChannelStreamingNativeTransport(entry) {
	return asBoolean(getChannelStreamingConfigObject(entry)?.nativeTransport) ?? asBoolean(entry?.nativeStreaming);
}
function resolveChannelPreviewStreamMode(entry, defaultMode) {
	const parsedStreaming = parsePreviewStreamingMode(getChannelStreamingConfigObject(entry)?.mode ?? entry?.streaming);
	if (parsedStreaming) return parsedStreaming;
	const legacy = parsePreviewStreamingMode(entry?.streamMode);
	if (legacy) return legacy;
	if (typeof entry?.streaming === "boolean") return entry.streaming ? "partial" : "off";
	return defaultMode;
}
function resolveChannelProgressDraftConfig(entry) {
	return asProgressConfig(getChannelStreamingConfigObject(entry)?.progress) ?? {};
}
function normalizeProgressLabels(labels) {
	if (!Array.isArray(labels)) return [...DEFAULT_PROGRESS_DRAFT_LABELS];
	const normalized = labels.map((entry) => typeof entry === "string" ? entry.trim() : "").filter((entry) => entry.length > 0);
	return normalized.length > 0 ? normalized : [...DEFAULT_PROGRESS_DRAFT_LABELS];
}
function hashProgressSeed(seed) {
	let hash = 2166136261;
	for (let index = 0; index < seed.length; index += 1) {
		hash ^= seed.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}
function resolveChannelProgressDraftLabel(params) {
	const progress = resolveChannelProgressDraftConfig(params.entry);
	if (progress.label === false) return;
	const normalizedLabel = typeof progress.label === "string" ? normalizeOptionalLowercaseString(progress.label) : null;
	if (typeof progress.label === "string" && progress.label.trim() && normalizedLabel !== "auto") return progress.label.trim();
	const labels = normalizeProgressLabels(progress.labels);
	return labels[typeof params.seed === "string" && params.seed.length > 0 ? hashProgressSeed(params.seed) % labels.length : Math.floor(Math.max(0, Math.min(.999999, params.random?.() ?? 0)) * labels.length)] ?? labels[0];
}
function resolveChannelProgressDraftMaxLines(entry, defaultValue = 8) {
	const configured = asInteger(resolveChannelProgressDraftConfig(entry).maxLines);
	return configured && configured > 0 ? configured : defaultValue;
}
function resolveChannelProgressDraftRender(entry, defaultValue = "text") {
	const configured = resolveChannelProgressDraftConfig(entry).render;
	return configured === "rich" || configured === "text" ? configured : defaultValue;
}
function sliceCodePoints(value, start, end) {
	return Array.from(value).slice(start, end).join("");
}
function compactProgressLineDetail(detail, maxChars) {
	const chars = Array.from(detail);
	if (chars.length <= maxChars) return detail;
	if (maxChars <= 1) return "…";
	const keepStart = Math.max(1, Math.ceil((maxChars - 1) * .45));
	const keepEnd = Math.max(1, maxChars - keepStart - 1);
	const rawStart = chars.slice(0, keepStart).join("").trimEnd();
	return `${rawStart.length > 8 && /\s+\S+$/.test(rawStart) ? rawStart.replace(/\s+\S+$/, "") : rawStart}…${chars.slice(-keepEnd).join("").trimStart()}`;
}
function removeUnbalancedInlineBackticks(value) {
	if (Array.from(value).filter((char) => char === "`").length % 2 === 0) return value;
	return value.trimStart().startsWith("`") ? value.replaceAll("`", "'") : value.replaceAll("`", "");
}
function compactChannelProgressDraftLine(line, maxChars) {
	const normalized = line.replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	if (Array.from(normalized).length <= maxChars) return normalized;
	if (maxChars <= 1) return "…";
	const splitIndex = normalized.indexOf(": ");
	if (splitIndex > 0) {
		const prefix = normalized.slice(0, splitIndex + 2);
		const detailLimit = maxChars - Array.from(prefix).length;
		if (detailLimit >= 8) return removeUnbalancedInlineBackticks(`${prefix}${compactProgressLineDetail(normalized.slice(splitIndex + 2), detailLimit)}`);
	}
	return removeUnbalancedInlineBackticks(`${sliceCodePoints(normalized, 0, maxChars - 1).trimEnd()}…`);
}
function getProgressDraftLineText(line) {
	return typeof line === "string" ? line : line.text;
}
function formatChannelProgressDraftText(params) {
	const label = resolveChannelProgressDraftLabel({
		entry: params.entry,
		seed: params.seed,
		random: params.random
	});
	const maxLines = resolveChannelProgressDraftMaxLines(params.entry);
	const formatLine = params.formatLine ?? ((line) => line);
	const bullet = params.bullet ?? "•";
	return [label, ...params.lines.map((line) => compactChannelProgressDraftLine(getProgressDraftLineText(line), DEFAULT_PROGRESS_DRAFT_MAX_LINE_CHARS)).filter((line) => line.length > 0).slice(-maxLines).map((line) => shouldPrefixProgressLine(line) ? `${bullet} ${formatLine(line)}` : formatLine(line))].filter((line) => Boolean(line)).join("\n");
}
//#endregion
export { resolveChannelStreamingPreviewToolProgress as C, resolveChannelStreamingPreviewCommandText as S, resolveChannelStreamingBlockCoalesce as _, createChannelProgressDraftGate as a, resolveChannelStreamingNativeTransport as b, formatChannelProgressDraftText as c, resolveChannelPreviewStreamMode as d, resolveChannelProgressDraftConfig as f, resolveChannelProgressDraftRender as g, resolveChannelProgressDraftMaxLines as h, buildChannelProgressDraftLineForEntry as i, getChannelStreamingConfigObject as l, resolveChannelProgressDraftLineOptions as m, DEFAULT_PROGRESS_DRAFT_LABELS as n, formatChannelProgressDraftLine as o, resolveChannelProgressDraftLabel as p, buildChannelProgressDraftLine as r, formatChannelProgressDraftLineForEntry as s, DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS as t, isChannelProgressDraftWorkToolName as u, resolveChannelStreamingBlockEnabled as v, resolveChannelStreamingSuppressDefaultToolProgressMessages as w, resolveChannelStreamingPreviewChunk as x, resolveChannelStreamingChunkMode as y };
