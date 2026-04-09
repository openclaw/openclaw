"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { DiffCard } from "./diff-viewer";
import { denchIntegrationsBrand } from "@/lib/dench-integrations-brand";

/* ─── Diff synthesis from edit tool args ─── */

/**
 * Build a unified diff string from old_string/new_string pairs.
 * This provides a visual diff even when the tool result doesn't include one.
 */
function buildSyntheticDiff(filePath: string, oldStr: string, newStr: string): string {
	const oldLines = oldStr.split("\n");
	const newLines = newStr.split("\n");
	const lines: string[] = [
		`--- a/${filePath}`,
		`+++ b/${filePath}`,
		`@@ -1,${oldLines.length} +1,${newLines.length} @@`,
	];
	for (const line of oldLines) {
		lines.push(`-${line}`);
	}
	for (const line of newLines) {
		lines.push(`+${line}`);
	}
	return lines.join("\n");
}

/* ─── Public types ─── */

export type ChainPart =
	| { kind: "reasoning"; text: string; isStreaming: boolean }
	| {
			kind: "tool";
			toolName: string;
			toolCallId: string;
			status: "running" | "done" | "error";
			args?: Record<string, unknown>;
			output?: Record<string, unknown>;
			errorText?: string;
		}
;

/* ─── Media / file type helpers ─── */

const IMAGE_EXTS = new Set([
	"jpg",
	"jpeg",
	"png",
	"gif",
	"webp",
	"svg",
	"bmp",
	"avif",
	"heic",
	"heif",
	"tiff",
	"tif",
	"ico",
]);
const VIDEO_EXTS = new Set([
	"mp4",
	"webm",
	"mov",
	"avi",
	"mkv",
]);
const PDF_EXTS = new Set(["pdf"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "m4a"]);

type MediaKind = "image" | "video" | "pdf" | "audio" | null;

function getFileExt(path: string): string {
	return (path.split(".").pop() ?? "").toLowerCase();
}

function detectMedia(path: string): MediaKind {
	const ext = getFileExt(path);
	if (IMAGE_EXTS.has(ext)) {return "image";}
	if (VIDEO_EXTS.has(ext)) {return "video";}
	if (PDF_EXTS.has(ext)) {return "pdf";}
	if (AUDIO_EXTS.has(ext)) {return "audio";}
	return null;
}

function rawFileUrl(path: string): string {
	return `/api/workspace/raw-file?path=${encodeURIComponent(path)}`;
}

/** Resolve a media URL — use raw URL directly if it's already HTTP */
function resolveMediaUrl(path: string): string {
	if (path.startsWith("http://") || path.startsWith("https://")) {
		return path;
	}
	return rawFileUrl(path);
}

/** Regex to find file paths with media extensions in free text */
const MEDIA_FILE_RE =
	/(?:^|[\s"'(=])(((?:\/|\.\/)?[\w.\-/\\]+)\.(?:jpe?g|png|gif|webp|svg|bmp|avif|heic|heif|tiff?|ico|mp4|webm|mov|avi|mkv|mp3|wav|ogg|m4a|pdf))\b/i;

const PATH_KEYS = [
	"path",
	"file",
	"file_path",
	"filePath",
	"filename",
	"url",
	"src",
	"name",
	"target",
];

/**
 * Extract the file path from tool args and/or output.
 * Searches standard keys, then all string values, then output text.
 */
function getFilePath(
	args?: Record<string, unknown>,
	output?: Record<string, unknown>,
): string | null {
	// 1. Check standard keys in args
	if (args) {
		for (const key of PATH_KEYS) {
			const v = args[key];
			if (typeof v === "string" && v.length > 0) {return v;}
		}
	}

	// 2. Check standard keys in output
	if (output) {
		for (const key of PATH_KEYS) {
			const v = output[key];
			if (typeof v === "string" && v.length > 0 && looksLikePath(v))
				{return v;}
		}
	}

	// 3. Scan all string values in args for file-like paths
	if (args) {
		const found = findPathInValues(args);
		if (found) {return found;}
	}

	// 4. Extract from output text
	if (output?.text && typeof output.text === "string") {
		const m = output.text.match(MEDIA_FILE_RE);
		if (m) {return m[1];}
	}

	// 5. Scan output values too
	if (output) {
		const found = findPathInValues(output);
		if (found) {return found;}
	}

	return null;
}

/** Check if a string looks like a file path (has an extension, no spaces) */
function looksLikePath(s: string): boolean {
	return (
		s.length > 2 &&
		s.length < 500 &&
		/\.\w{1,5}$/.test(s) &&
		!s.includes(" ")
	);
}

/** Search all string values in an object for a path-like string */
function findPathInValues(obj: Record<string, unknown>): string | null {
	for (const val of Object.values(obj)) {
		if (typeof val === "string" && looksLikePath(val)) {
			return val;
		}
	}
	return null;
}

/* ─── Domain / URL extraction helpers ─── */

const URL_RE = /https?:\/\/[^\s"'<>,;)}\]]+/gi;

function extractDomains(text: string): string[] {
	const urls = text.match(URL_RE) ?? [];
	const domains = new Set<string>();
	for (const url of urls) {
		try {
			const hostname = new URL(url).hostname;
			if (hostname && !hostname.includes("localhost")) {
				domains.add(hostname);
			}
		} catch {
			/* skip */
		}
	}
	return [...domains].slice(0, 8);
}

function faviconUrl(domain: string): string {
	return `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(domain)}`;
}

/* ─── Format tool args for display ─── */

/** Render tool arguments as a compact readable string. */
function formatArgs(args: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (value === undefined || value === null) {continue;}
		const str =
			typeof value === "string"
				? value
				: JSON.stringify(value, null, 2);
		lines.push(`${key}: ${str}`);
	}
	const joined = lines.join("\n");
	return joined.length > 2000 ? joined.slice(0, 2000) + "\n..." : joined;
}

function asRecordValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asRecordArrayValue(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is Record<string, unknown> =>
					Boolean(item) && typeof item === "object" && !Array.isArray(item),
			)
		: [];
}

function readStringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArrayValue(value: unknown): string[] {
	return Array.isArray(value)
		? value
				.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
				.map((item) => item.trim())
		: [];
}

function buildComposioSearchCardData(output?: Record<string, unknown>) {
	if (!output) {return null;}
	const results = asRecordArrayValue(output.results);
	const recommended = asRecordValue(output.recommended_result) ?? results[0];
	const topTools = results
		.slice(0, 3)
		.map((result) => readStringValue(result.tool) ?? readStringValue(result.tool_slug) ?? readStringValue(result.name))
		.filter((tool): tool is string => Boolean(tool));
	const selectedAccount = asRecordValue(recommended?.selected_account);
	const accountCandidates = asRecordArrayValue(recommended?.account_candidates ?? recommended?.accounts);
	const inputSchema = asRecordValue(recommended?.input_schema ?? recommended?.input_parameters);
	const schemaProperties = asRecordValue(inputSchema?.properties);
	const schemaPropertyNames = schemaProperties ? Object.keys(schemaProperties) : [];
	const requiredFields = readStringArrayValue(inputSchema?.required);
	const planSteps = readStringArrayValue(recommended?.recommended_plan_steps ?? output.next_steps_guidance).slice(0, 3);
	const pitfalls = readStringArrayValue(recommended?.known_pitfalls).slice(0, 2);
	const accountCount = typeof recommended?.account_count === "number" ? recommended.account_count : accountCandidates.length;
	const toolkitRec = asRecordValue(recommended?.toolkit);
	const toolkitName = readStringValue(toolkitRec?.name) ?? readStringValue(toolkitRec?.slug);
	const resultCount = typeof output.result_count === "number" ? output.result_count : results.length;
	const connectedToolkits = readStringArrayValue(output.connected_toolkits);
	const toolkitFilter = readStringValue(output.toolkit_filter) ?? readStringValue(output.app_filter);
	const resultSummary = resultCount > 0
		? `${resultCount} tool${resultCount === 1 ? "" : "s"} found`
		: toolkitFilter
			? `No ${toolkitFilter} tools matched`
			: "No tools matched";
	return {
		resultSummary,
		connectedToolkits: connectedToolkits.length > 0 ? connectedToolkits.join(", ") : null,
		topTools,
		sessionId: readStringValue(output.search_session_id),
		accountSummary:
			readStringValue(selectedAccount?.display_label) ??
			(accountCount > 0
				? `${accountCount} connected account${accountCount === 1 ? "" : "s"}${toolkitName ? ` (${toolkitName})` : ""}`
				: recommended?.is_connected === true ? "Connected" : null),
		schemaSummary:
			schemaPropertyNames.length > 0
				? `${schemaPropertyNames.length} input fields${requiredFields.length > 0 ? `, ${requiredFields.length} required` : ""}`
				: null,
		schemaText: inputSchema ? JSON.stringify(inputSchema, null, 2) : null,
		planSteps,
		pitfalls,
	};
}

function buildComposioCallCardData(
	args?: Record<string, unknown>,
	output?: Record<string, unknown>,
) {
	const execution = asRecordValue(output?.execution);
	const recovery = asRecordValue(output?.recovery);
	const toolName =
		readStringValue(args?.tool_name) ??
		readStringValue(args?.tool_slug) ??
		readStringValue(output?.tool_slug) ??
		readStringValue(execution?.tool_name);
	if (!toolName) {return null;}
	const toolArgs = asRecordValue(args?.arguments);
	const keyArgs = toolArgs
		? Object.entries(toolArgs)
				.slice(0, 3)
				.map(([key, value]) => {
					const formatted =
						typeof value === "string" ? value : JSON.stringify(value);
					return `${key}: ${formatted}`;
				})
		: [];
	const structuredContent = asRecordValue(output?.structuredContent);
	const dataSource = structuredContent ?? output;
	const items =
		Array.isArray(dataSource?.data) ? dataSource.data :
		Array.isArray(dataSource?.items) ? dataSource.items :
		undefined;
	const resultSummary =
		items
			? `${items.length} result${items.length === 1 ? "" : "s"}`
			: readStringValue(output?.status) ?? null;
	const paginationBits = [
		Object.hasOwn(dataSource ?? {}, "has_more")
			? `has_more: ${String(dataSource?.has_more)}`
			: null,
		readStringValue(dataSource?.next_cursor)
			? `next_cursor: ${readStringValue(dataSource?.next_cursor)}`
			: null,
		readStringValue(dataSource?.starting_after)
			? `starting_after: ${readStringValue(dataSource?.starting_after)}`
			: null,
	].filter((value): value is string => Boolean(value));
	const recoveryBits = [
		readStringValue(recovery?.recovered_via),
		readStringValue(recovery?.retried_with_account)
			? `account: ${readStringValue(recovery?.retried_with_account)}`
			: null,
		readStringValue(recovery?.refreshed_execution_ref)
			? "refreshed execution_ref returned"
			: null,
	].filter((value): value is string => Boolean(value));
	const toolSlugParts = toolName.split("_");
	const inferredToolkit = toolSlugParts.length > 1 ? toolSlugParts[0]?.toLowerCase() : null;
	return {
		app:
			readStringValue(args?.app) ??
			readStringValue(output?.toolkit) ??
			readStringValue(execution?.toolkit) ??
			inferredToolkit,
		toolName,
		account:
			readStringValue(args?.account) ??
			readStringValue(output?.account) ??
			readStringValue(execution?.account) ??
			readStringValue(args?.connected_account_id) ??
			readStringValue(output?.connectedAccountId) ??
			readStringValue(args?.account_identity),
		keyArgs,
		pagination: paginationBits.length > 0 ? paginationBits.join(" | ") : null,
		resultSummary,
		sessionId:
			readStringValue(output?.tool_router_session_id) ??
			readStringValue(execution?.tool_router_session_id),
		recoverySummary: recoveryBits.length > 0 ? recoveryBits.join(" | ") : null,
	};
}

function SummaryRow({
	label,
	value,
}: {
	label: string;
	value: string;
}) {
	return (
		<div className="text-[11px] leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
			<span style={{ color: "var(--color-text-muted)" }}>{label}: </span>
			<span>{value}</span>
		</div>
	);
}

/* ─── Classify tool steps ─── */

type StepKind =
	| "composio"
	| "search"
	| "fetch"
	| "read"
	| "exec"
	| "write"
	| "image"
	| "generic";

function classifyTool(
	name: string,
	args?: Record<string, unknown>,
	output?: Record<string, unknown>,
): StepKind {
	if (name === "dench_search_integrations" || name === "dench_execute_integrations" || name === "composio_search_tools" || name === "composio_call_tool") {
		return "composio";
	}
	const n = name.toLowerCase().replace(/[_-]/g, "");
	if (
		[
			"websearch",
			"search",
			"googlesearch",
			"bingsearch",
			"browsersearch",
			"tavily",
		].some((k) => n.includes(k))
	)
		{return "search";}

	// Browser tool — classify based on the action being performed
	if (n === "browser") {
		const action =
			typeof args?.action === "string"
				? args.action.toLowerCase()
				: "";
		if (action === "open" || action === "navigate") {return "fetch";}
		if (action === "screenshot") {return "image";}
		return "generic"; // act/snapshot/status etc. have no URL
	}

	if (
		["fetchurl", "fetch", "browse", "browseurl", "webfetch"].some(
			(k) => n.includes(k),
		)
	)
		{return "fetch";}
	if (
		["read", "file", "readfile", "getfile"].some(
			(k) => n.includes(k),
		)
	)
		{return "read";}
	if (
		[
			"bash",
			"shell",
			"execute",
			"exec",
			"terminal",
			"command",
			"run",
		].some((k) => n.includes(k))
	)
		{return "exec";}
	if (
		[
			"write",
			"create",
			"edit",
			"str_replace",
			"save",
			"patch",
		].some((k) => n.includes(k))
	)
		{return "write";}
	if (
		[
			"image",
			"screenshot",
			"photo",
			"picture",
			"dalle",
			"generateimage",
		].some((k) => n.includes(k))
	)
		{
			const description =
				typeof args?.description === "string"
					? args.description.trim()
					: "";
			if (description || n.includes("generateimage") || n.includes("dalle")) {
				return "image";
			}

			const filePath = getFilePath(args, output);
			if (filePath && detectMedia(filePath) === "image") {
				return "read";
			}

			return "image";
		}
	return "generic";
}

function buildStepLabel(
	kind: StepKind,
	toolName: string,
	args?: Record<string, unknown>,
	output?: Record<string, unknown>,
): string {
	const strVal = (key: string) => {
		const v = args?.[key];
		return typeof v === "string" && v.length > 0 ? v : null;
	};

	switch (kind) {
		case "composio":
			return toolName === "dench_search_integrations" || toolName === "composio_search_tools"
				? denchIntegrationsBrand.searchLabel
				: toolName === "dench_execute_integrations" || toolName === "composio_call_tool"
					? denchIntegrationsBrand.callLabel
					: denchIntegrationsBrand.genericToolLabel;
		case "search": {
			const q =
				strVal("query") ??
				strVal("search_query") ??
				strVal("search") ??
				strVal("q");
			return q ? `Searching for ${q}` : "Searching...";
		}
		case "fetch": {
			const u =
				strVal("url") ??
				strVal("targetUrl") ??
				strVal("path") ??
				strVal("src");
			if (u) {
				try {
					return `Fetching ${new URL(u).hostname}`;
				} catch {
					return `Fetching ${u}`;
				}
			}
			// Fallback: check output for the URL (web_fetch results include url/finalUrl)
			const outUrl =
				(typeof output?.finalUrl === "string" && output.finalUrl) ||
				(typeof output?.url === "string" && output.url);
			if (outUrl) {
				try {
					return `Fetched ${new URL(outUrl).hostname}`;
				} catch {
					return `Fetched ${outUrl}`;
				}
			}
			return "Fetching page";
		}
		case "read": {
			const p = getFilePath(args, output);
			if (p) {
				const short = p.split("/").pop() ?? p;
				return short.startsWith("http")
					? `Fetching ${short}`
					: `Reading ${short}`;
			}
			return "Reading file";
		}
		case "exec": {
			const cmd = strVal("command") ?? strVal("cmd");
			if (cmd) {return `Running: ${cmd}`;}
			return "Running command";
		}
		case "write": {
			const p = strVal("path") ?? strVal("file") ?? strVal("file_path");
			if (p) {
				const short = p.split("/").pop() ?? p;
				return `Editing ${short}`;
			}
			return "Editing file";
		}
		case "image":
			return strVal("description")
				? `Generating image: ${strVal("description")!}`
				: "Generating image";
		default: {
			// For generic/unknown tools, build a descriptive label from args
			const name = toolName
				.replace(/_/g, " ")
				.replace(/\b\w/g, (c) => c.toUpperCase())
				.trim();
			if (args) {
				// Try common arg patterns for a meaningful summary
				const desc =
					strVal("command") ??
					strVal("cmd") ??
					strVal("query") ??
					strVal("path") ??
					strVal("url") ??
					strVal("message") ??
					strVal("description") ??
					strVal("input") ??
					strVal("text");
				if (desc) {return `${name}: ${desc}`;}
			}
			return name || "Tool";
		}
	}
}

/** Extract domains from tool output for search steps */
function getSearchDomains(
	output?: Record<string, unknown>,
): string[] {
	if (!output) {return [];}
	const text = typeof output.text === "string" ? output.text : "";
	const results = output.results;
	const citations = output.citations;
	let combined = text;
	if (Array.isArray(results)) {
		for (const r of results) {
			if (typeof r === "string") {
				combined += ` ${r}`;
			} else if (typeof r === "object" && r !== null) {
				const obj = r as Record<string, unknown>;
				if (typeof obj.url === "string")
					{combined += ` ${obj.url}`;}
				if (typeof obj.link === "string")
					{combined += ` ${obj.link}`;}
			}
		}
	}
	if (Array.isArray(citations)) {
		for (const c of citations) {
			// Citations can be plain URL strings or objects with a url field
			if (typeof c === "string") {
				combined += ` ${c}`;
			} else if (typeof c === "object" && c !== null) {
				const obj = c as Record<string, unknown>;
				if (typeof obj.url === "string")
					{combined += ` ${obj.url}`;}
			}
		}
	}
	// Scan all remaining string values in the output for URLs we may have missed
	for (const val of Object.values(output)) {
		if (typeof val === "string" && val !== text && val.includes("http")) {
			combined += ` ${val}`;
		}
	}
	return extractDomains(combined);
}

/** Extract domain(s) from fetch/browser tool args and/or output */
function getFetchDomains(
	args?: Record<string, unknown>,
	output?: Record<string, unknown>,
): string[] {
	const domains = new Set<string>();
	// Check args for URL (web_fetch uses "url", browser tool uses "targetUrl")
	for (const key of ["url", "targetUrl", "path", "src"]) {
		const v = args?.[key];
		if (typeof v === "string" && v.startsWith("http")) {
			try {
				const hostname = new URL(v).hostname;
				if (hostname && !hostname.includes("localhost")) {
					domains.add(hostname);
				}
			} catch {
				/* skip */
			}
		}
	}
	// Check output for URL / finalUrl
	for (const key of ["url", "finalUrl", "targetUrl"]) {
		const v = output?.[key];
		if (typeof v === "string" && v.startsWith("http")) {
			try {
				const hostname = new URL(v).hostname;
				if (hostname && !hostname.includes("localhost")) {
					domains.add(hostname);
				}
			} catch {
				/* skip */
			}
		}
	}
	return [...domains].slice(0, 4);
}

/* ─── Group consecutive media reads ─── */

type ToolPart = Extract<ChainPart, { kind: "tool" }>;

type VisualItem =
	| { type: "tool"; tool: ToolPart }
	| {
			type: "media-group";
			mediaKind: "image" | "video" | "pdf" | "audio";
			items: Array<{ path: string; tool: ToolPart }>;
		}
	| {
			type: "fetch-group";
			items: ToolPart[];
		};

function groupToolSteps(tools: ToolPart[]): VisualItem[] {
	const result: VisualItem[] = [];
	let i = 0;
	while (i < tools.length) {
		const tool = tools[i];
		const kind = classifyTool(tool.toolName, tool.args, tool.output);
		// Check both args AND output for the file path
		const filePath = getFilePath(tool.args, tool.output);
		const media = filePath ? detectMedia(filePath) : null;

		// If this is a media read, look for consecutive media reads of the same kind
		if (kind === "read" && media && filePath) {
			const group: Array<{ path: string; tool: ToolPart }> = [
				{ path: filePath, tool },
			];
			let j = i + 1;
			while (j < tools.length) {
				const next = tools[j];
				const nextKind = classifyTool(next.toolName, next.args, next.output);
				const nextPath = getFilePath(next.args, next.output);
				const nextMedia = nextPath ? detectMedia(nextPath) : null;
				if (nextKind === "read" && nextMedia === media && nextPath) {
					group.push({ path: nextPath, tool: next });
					j++;
				} else {
					break;
				}
			}
			result.push({
				type: "media-group",
				mediaKind: media,
				items: group,
			});
			i = j;
		} else if (kind === "fetch") {
			// Group consecutive fetch tools into a single compact card
			const group: ToolPart[] = [tool];
			let j = i + 1;
			while (j < tools.length) {
				const next = tools[j];
				const nextKind = classifyTool(next.toolName, next.args, next.output);
				if (nextKind === "fetch") {
					group.push(next);
					j++;
				} else {
					break;
				}
			}
			if (group.length > 1) {
				result.push({ type: "fetch-group", items: group });
			} else {
				result.push({ type: "tool", tool });
			}
			i = j;
		} else {
			result.push({ type: "tool", tool });
			i++;
		}
	}
	return result;
}

/* ─── Main component ─── */

export function ChainOfThought({ parts, isStreaming }: { parts: ChainPart[]; isStreaming?: boolean }) {
	const [isOpen, setIsOpen] = useState(!!isStreaming);

	const isActive = parts.some(
		(p) =>
			(p.kind === "reasoning" && p.isStreaming) ||
			(p.kind === "tool" && p.status === "running"),
	);

	/* ─── Live elapsed-time tracking ─── */
	const startRef = useRef<number | null>(null);
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		if (isActive && startRef.current === null) {
			startRef.current = Date.now();
		}
	}, [isActive]);

	useEffect(() => {
		if (!isActive) {return;}
		const tick = () => {
			if (startRef.current !== null) {
				setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
			}
		};
		tick();
		const id = setInterval(tick, 1000);
		return () => clearInterval(id);
	}, [isActive]);

	const formatDuration = useCallback((s: number) => {
		if (s < 60) {return `${s}s`;}
		const m = Math.floor(s / 60);
		const rem = s % 60;
		return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
	}, []);

	// Collapse only when the parent stream truly ends — not on intermediate
	// isActive flickers (e.g. gap between reasoning end and tool start).
	const wasStreamingRef = useRef(false);
	useEffect(() => {
		if (isStreaming) {
			wasStreamingRef.current = true;
		} else if (wasStreamingRef.current && parts.length > 0) {
			wasStreamingRef.current = false;
			setIsOpen(false);
		}
	}, [isStreaming, parts.length]);

	const reasoningText = parts
		.filter(
			(p): p is Extract<ChainPart, { kind: "reasoning" }> =>
				p.kind === "reasoning",
		)
		.map((p) => p.text)
		.join("");
	const isReasoningStreaming = parts.some(
		(p) => p.kind === "reasoning" && p.isStreaming,
	);

	const tools = parts.filter(
		(p): p is ToolPart => p.kind === "tool",
	);
	const visualItems = groupToolSteps(tools);

	const headerLabel = isActive
		? elapsed > 0
			? `Thinking for ${formatDuration(elapsed)}`
			: "Thinking..."
		: elapsed > 0
			? `Thought for ${formatDuration(elapsed)}`
			: "Thought";

	return (
		<div className="my-3">
			{/* Header trigger */}
			<button
				type="button"
				onClick={() => setIsOpen((v) => !v)}
				className="flex items-center gap-2 py-1 text-[13px] cursor-pointer group"
				style={{ color: "var(--color-text-muted)" }}
			>
				<ThinkingIcon className="w-4 h-4 flex-shrink-0 opacity-60" />
				<span className="font-medium">
					{headerLabel}
				</span>
				<ChevronIcon
					className={`w-3.5 h-3.5 ml-1 flex-shrink-0 transition-transform duration-200 ${
						isOpen ? "" : "-rotate-90"
					}`}
				/>
			</button>

			{/* Collapsible content */}
			<AnimatePresence initial={false}>
				{isOpen && (
					<motion.div
						key="content"
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
						className="overflow-hidden"
					>
						<div className="relative pt-2 pb-1">
							{/* Timeline connector line */}
							<div
								className="absolute w-px"
								style={{
									left: 9,
									top: 16,
									bottom: 8,
									background: "var(--color-border)",
								}}
							/>
							<AnimatePresence initial={false}>
							{reasoningText && (
								<motion.div
									key="reasoning"
									initial={{ opacity: 0, y: 6 }}
									animate={{ opacity: 1, y: 0 }}
									transition={{ duration: 0.25, ease: "easeOut" }}
									className="flex items-start gap-2.5 py-1.5"
								>
									<div
										className="relative z-10 flex-shrink-0 w-[18px] h-[18px] flex items-center justify-center rounded-full"
										style={{
											background: "var(--color-bg)",
										}}
									>
										<svg
											width="14"
											height="14"
											viewBox="0 0 24 24"
											fill="none"
											stroke="var(--color-text-muted)"
											strokeWidth="2"
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z" />
											<path d="M10 21h4" />
										</svg>
									</div>
									<div className="flex-1 min-w-0">
										<ReasoningBlock
											text={reasoningText}
											isStreaming={
												isReasoningStreaming
											}
										/>
									</div>
								</motion.div>
							)}
							{visualItems.map((item, idx) => {
								if (item.type === "media-group") {
									return (
										<motion.div
											key={`media-${idx}`}
											initial={{ opacity: 0, y: 6 }}
											animate={{ opacity: 1, y: 0 }}
											transition={{ duration: 0.25, ease: "easeOut" }}
										>
											<MediaGroup
												mediaKind={item.mediaKind}
												items={item.items}
											/>
										</motion.div>
									);
								}
								if (item.type === "fetch-group") {
									return (
										<motion.div
											key={`fetch-${idx}`}
											initial={{ opacity: 0, y: 6 }}
											animate={{ opacity: 1, y: 0 }}
											transition={{ duration: 0.25, ease: "easeOut" }}
										>
											<FetchGroup items={item.items} />
										</motion.div>
									);
								}
								return (
									<motion.div
										key={item.tool.toolCallId}
										initial={{ opacity: 0, y: 6 }}
										animate={{ opacity: 1, y: 0 }}
										transition={{ duration: 0.25, ease: "easeOut" }}
									>
										<ToolStep
											{...item.tool}
										/>
									</motion.div>
								);
							})}
							</AnimatePresence>
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}

/* ─── Reasoning block ─── */

function ReasoningBlock({
	text,
	isStreaming: _isStreaming,
}: {
	text: string;
	isStreaming: boolean;
}) {
	return (
		<div className="mb-2">
			<div
			className="text-[13px] whitespace-pre-wrap leading-relaxed"
			style={{ color: "var(--color-text-muted)" }}
			>
				{text}
			</div>
		</div>
	);
}

/* ─── Fetch group (consecutive web fetches in one compact card) ─── */

function FetchGroup({ items }: { items: ToolPart[] }) {
	const anyRunning = items.some((t) => t.status === "running");
	const doneCount = items.filter((t) => t.status === "done").length;

	return (
		<div className="flex items-start gap-2.5 py-1.5">
			<div
				className="relative z-10 flex-shrink-0 w-[18px] h-[18px] flex items-center justify-center rounded-full"
				style={{ background: "var(--color-bg)" }}
			>
				<span className={anyRunning ? "animate-pulse" : ""}>
					<StepIcon kind="fetch" />
				</span>
			</div>
			<div className="flex-1 min-w-0">
				<div
					className="text-[13px] leading-snug mb-1.5 flex items-center justify-between"
					style={{
						color: anyRunning
							? "var(--color-text)"
							: "var(--color-text-secondary)",
					}}
				>
					<span className={anyRunning ? "animate-pulse" : ""}>
						{anyRunning
							? `Fetching ${items.length} sources...`
							: `Fetched ${items.length} sources`}
					</span>
					{!anyRunning && (
						<span
							className="text-[11px]"
							style={{ color: "var(--color-text-muted)" }}
						>
							{doneCount} {doneCount === 1 ? "result" : "results"}
						</span>
					)}
				</div>
				<div
					className="rounded-2xl overflow-hidden"
					style={{
						background: "var(--color-surface)",
						border: "1px solid var(--color-border)",
					}}
				>
					{items.map((tool) => {
						const { domain, url } = getFetchDomainAndUrl(tool.args, tool.output);
						return (
							<a
								key={tool.toolCallId}
								href={url ?? undefined}
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center gap-2.5 px-3 py-2.5 text-[12px] no-underline"
								style={{
									color: "var(--color-text)",
									cursor: url ? "pointer" : "default",
								}}
								onMouseEnter={(e) => { e.currentTarget.style.background = "var(--color-surface-hover)"; }}
								onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
								onClick={url ? undefined : (e) => e.preventDefault()}
							>
								{domain ? (
									/* eslint-disable-next-line @next/next/no-img-element */
									<img
										src={faviconUrl(domain)}
										alt=""
										width={16}
										height={16}
										className="rounded-sm flex-shrink-0"
										loading="lazy"
									/>
								) : (
									<div
										className="w-4 h-4 rounded-sm flex-shrink-0"
										style={{ background: "var(--color-surface-hover)" }}
									/>
								)}
								<span
									className="flex-1 min-w-0 truncate"
									style={{ color: "var(--color-text)" }}
								>
									{domain?.replace(/^www\./, "") ?? url ?? "Fetching..."}
								</span>
								{tool.status === "running" ? (
									<span
										className="w-2 h-2 rounded-full animate-pulse flex-shrink-0"
										style={{ background: "var(--color-accent)" }}
									/>
								) : url ? (
									<span
										className="text-[11px] truncate max-w-[45%] text-right"
										style={{ color: "var(--color-text-muted)" }}
										title={url}
									>
										{url}
									</span>
								) : null}
							</a>
						);
					})}
				</div>
			</div>
		</div>
	);
}

/** Extract domain and full URL from fetch tool args/output */
function getFetchDomainAndUrl(
	args?: Record<string, unknown>,
	output?: Record<string, unknown>,
): { domain: string | null; url: string | null } {
	for (const key of ["url", "targetUrl", "path", "src"]) {
		const v = args?.[key];
		if (typeof v === "string" && v.startsWith("http")) {
			try {
				return { domain: new URL(v).hostname, url: v };
			} catch {
				/* skip */
			}
		}
	}
	for (const key of ["url", "finalUrl", "targetUrl"]) {
		const v = output?.[key];
		if (typeof v === "string" && v.startsWith("http")) {
			try {
				return { domain: new URL(v).hostname, url: v };
			} catch {
				/* skip */
			}
		}
	}
	return { domain: null, url: null };
}

/* ─── Media group (images, videos, PDFs, audio) ─── */

function MediaGroup({
	mediaKind,
	items,
}: {
	mediaKind: "image" | "video" | "pdf" | "audio";
	items: Array<{ path: string; tool: ToolPart }>;
}) {
	const [expanded, setExpanded] = useState(false);
	const anyRunning = items.some(
		(i) => i.tool.status === "running",
	);

	// Show completed items progressively — don't wait for allDone
	const completedItems = items.filter(
		(i) => i.tool.status === "done",
	);
	const doneCount = completedItems.length;

	const label = anyRunning
		? `Reading ${items.length} ${mediaKind}${items.length > 1 ? "s" : ""}...`
		: mediaKind === "image"
			? items.length === 1
				? `Read 1 image`
				: `Read ${items.length} images`
			: mediaKind === "video"
				? items.length === 1
					? `Read 1 video`
					: `Read ${items.length} videos`
				: mediaKind === "pdf"
					? items.length === 1
						? `Read 1 PDF`
						: `Read ${items.length} PDFs`
					: items.length === 1
						? `Read 1 audio file`
						: `Read ${items.length} audio files`;

	// Show up to 6 thumbnails by default, expandable
	const PREVIEW_COUNT = 6;
	const displayItems = expanded
		? completedItems
		: completedItems.slice(0, PREVIEW_COUNT);
	const hasMore =
		completedItems.length > PREVIEW_COUNT && !expanded;

	return (
		<div className="flex items-start gap-2.5 py-1.5">
			<div
				className="relative z-10 flex-shrink-0 w-[18px] h-[18px] flex items-center justify-center rounded-full"
				style={{ background: "var(--color-bg)" }}
			>
				<span className={anyRunning ? "animate-pulse" : ""}>
					<StepIcon
						kind={
							mediaKind === "image"
								? "image"
								: "read"
						}
					/>
				</span>
			</div>
			<div className="flex-1 min-w-0">
				<div
					className={`text-[13px] leading-snug mb-1.5${anyRunning ? " animate-pulse" : ""}`}
					style={{
						color: anyRunning
							? "var(--color-text)"
							: "var(--color-text-secondary)",
					}}
				>
					{label}
				</div>

				{/* Image thumbnail grid — show progressively as items complete */}
				{doneCount > 0 && mediaKind === "image" && (
					<div className="flex flex-wrap gap-1.5">
						{displayItems.map((item) => (
							<MediaThumb
								key={item.tool.toolCallId}
								path={item.path}
								single={items.length === 1}
							/>
						))}
						{anyRunning && (
							<div
								className="flex items-center justify-center rounded-lg"
								style={{
									width: 80,
									height: 80,
									background:
										"var(--color-surface-hover)",
									border: "1px solid var(--color-border)",
								}}
							>
								<span className="animate-pulse" style={{ color: "var(--color-text-muted)" }}>
									<StepIcon kind="image" />
								</span>
							</div>
						)}
						{hasMore && (
							<button
								type="button"
								onClick={() => setExpanded(true)}
								className="flex items-center justify-center rounded-lg text-xs font-medium cursor-pointer"
								style={{
									width: 80,
									height: 80,
									background:
										"var(--color-surface-hover)",
									color: "var(--color-text-muted)",
									border: "1px solid var(--color-border)",
								}}
							>
								+
								{completedItems.length -
									PREVIEW_COUNT}{" "}
								more
							</button>
						)}
					</div>
				)}

				{/* Video inline */}
				{doneCount > 0 && mediaKind === "video" && (
					<div className="flex flex-wrap gap-2">
						{displayItems.map((item) => (
							<video
								key={item.tool.toolCallId}
								src={resolveMediaUrl(item.path)}
								controls
								preload="metadata"
								className="rounded-lg max-w-[240px] max-h-[160px]"
								style={{
									border: "1px solid var(--color-border)",
								}}
							/>
						))}
					</div>
				)}

				{/* PDF links */}
				{doneCount > 0 && mediaKind === "pdf" && (
					<div className="flex flex-col gap-1.5">
						{displayItems.map((item) => {
							const filename =
								item.path.split("/").pop() ??
								item.path;
							return (
								<a
									key={item.tool.toolCallId}
									href={resolveMediaUrl(
										item.path,
									)}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-[12px]"
									style={{
										background:
											"var(--color-surface-hover)",
										color: "var(--color-text-secondary)",
										border: "1px solid var(--color-border)",
									}}
								>
									<PdfIcon />
									<span className="truncate max-w-[200px]">
										{filename}
									</span>
								</a>
							);
						})}
					</div>
				)}

				{/* Audio inline */}
				{doneCount > 0 && mediaKind === "audio" && (
					<div className="flex flex-col gap-1.5">
						{displayItems.map((item) => (
							<audio
								key={item.tool.toolCallId}
								src={resolveMediaUrl(item.path)}
								controls
								preload="metadata"
								className="max-w-[280px] h-8"
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

/** Image thumbnail with error fallback */
function MediaThumb({
	path,
	single,
}: {
	path: string;
	single: boolean;
}) {
	const [error, setError] = useState(false);
	const filename = path.split("/").pop() ?? path;
	const url = resolveMediaUrl(path);
	const w = single ? 200 : 80;
	const h = single ? 150 : 80;

	if (error) {
		return (
			<div
				className="flex items-center justify-center rounded-lg text-[10px] text-center p-1"
				style={{
					width: w,
					height: h,
					background: "var(--color-surface-hover)",
					color: "var(--color-text-muted)",
					border: "1px solid var(--color-border)",
				}}
				title={path}
			>
				<span className="truncate">{filename}</span>
			</div>
		);
	}

	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			className="block rounded-lg overflow-hidden flex-shrink-0"
			style={{
				border: "1px solid var(--color-border)",
				width: w,
				height: h,
			}}
			title={filename}
		>
			{/* eslint-disable-next-line @next/next/no-img-element */}
			<img
				src={url}
				alt={filename}
				className="w-full h-full object-cover"
				loading="lazy"
				onError={() => setError(true)}
			/>
		</a>
	);
}

/* ─── Tool step (non-media) ─── */

function ToolStep({
	toolName,
	status,
	args,
	output,
	errorText,
}: {
	toolName: string;
	status: "running" | "done" | "error";
	args?: Record<string, unknown>;
	output?: Record<string, unknown>;
	errorText?: string;
}) {
	const kind = classifyTool(toolName, args, output);
	const isComposioSearch = toolName === "dench_search_integrations" || toolName === "composio_search_tools";
	const isComposioCall = toolName === "dench_execute_integrations" || toolName === "composio_call_tool";
	const isComposioTool = isComposioSearch || isComposioCall;
	// Show output by default for exec/command tools — these are the most
	// useful to see inline.  Other tools default to collapsed.
	const [showOutput, setShowOutput] = useState(
		!isComposioTool && (kind === "exec" || kind === "generic"),
	);
	// Auto-expand diffs for write tool steps
	const [showDiff, setShowDiff] = useState(true);
	const label = buildStepLabel(kind, toolName, args, output);
	const composioSearchCard = isComposioSearch
		? buildComposioSearchCardData(output)
		: null;
	const composioCallCard = isComposioCall
		? buildComposioCallCardData(args, output)
		: null;
	const domains =
		kind === "search"
			? getSearchDomains(output)
			: kind === "fetch"
				? getFetchDomains(args, output)
				: [];
	const fallbackErrorText =
		typeof output?.error === "string" ? output.error : undefined;
	const resolvedErrorText = errorText ?? fallbackErrorText;
	const outputText =
		typeof output?.text === "string" ? output.text : undefined;

	// Detect diff data from edit/write tool results.
	// Priority: output.diff (from edit tool), then synthesize from args.
	const diffText = (() => {
		if (kind !== "write" || status !== "done") {return undefined;}
		// 1. Direct diff from tool result (edit tool returns this)
		if (typeof output?.diff === "string") {return output.diff;}
		// 2. Synthesize from edit args (old_string/new_string or oldText/newText)
		const oldStr =
			typeof args?.old_string === "string" ? args.old_string :
			typeof args?.oldText === "string" ? args.oldText : null;
		const newStr =
			typeof args?.new_string === "string" ? args.new_string :
			typeof args?.newText === "string" ? args.newText : null;
		if (oldStr !== null && newStr !== null) {
			const path = typeof args?.path === "string" ? args.path :
				typeof args?.file_path === "string" ? args.file_path : "file";
			return buildSyntheticDiff(path, oldStr, newStr);
		}
		return undefined;
	})();

	// For single-file reads that are media, render inline preview
	const filePath = getFilePath(args, output);
	const media = filePath ? detectMedia(filePath) : null;
	const isSingleMedia = kind === "read" && media && status === "done";

	return (
		<div className="flex items-start gap-2.5 py-1.5">
			<div
				className="relative z-10 flex-shrink-0 w-[18px] h-[18px] flex items-center justify-center rounded-full"
				style={{ background: "var(--color-bg)" }}
			>
				{status === "error" ? (
					<ErrorCircleIcon />
				) : (
					<span className={status === "running" ? "animate-pulse" : ""}>
						<StepIcon kind={kind} />
					</span>
				)}
			</div>

			<div className="flex-1 min-w-0">
				<div
					className="text-[13px] leading-snug flex items-center gap-2 flex-wrap"
					style={{
						color:
							status === "running"
								? "var(--color-text)"
								: "var(--color-text-secondary)",
					}}
				>
					<span
						className={`break-all${status === "running" ? " animate-pulse" : ""}${outputText && !isSingleMedia && !diffText && status === "done" ? " cursor-pointer hover:underline" : ""}`}
						onClick={outputText && !isSingleMedia && !diffText && status === "done" ? () => setShowOutput((v) => !v) : undefined}
					>{label}</span>
					{/* Exit code badge for exec tools */}
					{kind === "exec" && status === "done" && output?.exitCode !== undefined && (
						<span
							className="text-[11px] font-mono px-1.5 py-0.5 rounded"
							style={{
								background: output.exitCode === 0
									? "color-mix(in srgb, var(--color-success, #22c55e) 12%, transparent)"
									: "color-mix(in srgb, var(--color-error) 12%, transparent)",
								color: output.exitCode === 0
									? "var(--color-success, #22c55e)"
									: "var(--color-error)",
							}}
						>
							exit {typeof output.exitCode === "object" && output.exitCode != null ? JSON.stringify(output.exitCode) : typeof output.exitCode === "number" ? String(output.exitCode) : typeof output.exitCode === "string" ? output.exitCode : ""}
						</span>
					)}
				</div>

				{/* Inline diff for edit/write tool steps */}
				{diffText && status === "done" && (
					<div className="mt-1.5">
						<button
							type="button"
							onClick={() => setShowDiff((v) => !v)}
							className="text-[11px] hover:underline cursor-pointer mb-1"
							style={{ color: "var(--color-accent)" }}
						>
							{showDiff ? "Hide changes" : "Show changes"}
						</button>
						{showDiff && (
							<DiffCard diff={diffText} />
						)}
					</div>
				)}

				{/* Single media inline preview (when not grouped) */}
				{isSingleMedia && filePath && media === "image" && (
					<div className="mt-1.5">
						<MediaThumb path={filePath} single />
					</div>
				)}

				{isSingleMedia && filePath && media === "video" && (
					<video
						src={resolveMediaUrl(filePath)}
						controls
						preload="metadata"
						className="mt-1.5 rounded-lg max-w-[240px] max-h-[160px]"
						style={{
							border: "1px solid var(--color-border)",
						}}
					/>
				)}

				{isSingleMedia && filePath && media === "pdf" && (
					<a
						href={resolveMediaUrl(filePath)}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-2 mt-1.5 px-3 py-2 rounded-lg text-[12px]"
						style={{
							background: "var(--color-surface-hover)",
							color: "var(--color-text-secondary)",
							border: "1px solid var(--color-border)",
						}}
					>
						<PdfIcon />
						<span className="truncate max-w-[200px]">
							{filePath.split("/").pop() ?? filePath}
						</span>
					</a>
				)}

				{isSingleMedia && filePath && media === "audio" && (
					<audio
						src={resolveMediaUrl(filePath)}
						controls
						preload="metadata"
						className="mt-1.5 max-w-[280px] h-8"
					/>
				)}

				{/* Domain badges (search results / fetched page) — skip when running, the running section handles its own */}
				{domains.length > 0 && status !== "running" && (
					<div className="flex items-center gap-1.5 flex-wrap mt-1.5">
						{domains.map((domain) => (
							<DomainBadge
								key={domain}
								domain={domain}
							/>
						))}
					</div>
				)}

				{(kind === "search" || kind === "fetch") &&
					status === "running" &&
					args && (
						<div className="flex items-center gap-1.5 flex-wrap mt-1.5">
							{/* Show favicon badges for known domains while running */}
							{domains.length > 0
								? domains.map((domain) => (
										<span
											key={domain}
											className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12px]"
											style={{
												background:
													"var(--color-surface-hover)",
												color: "var(--color-text-secondary)",
												border: "1px solid var(--color-border)",
											}}
										>
											{/* eslint-disable-next-line @next/next/no-img-element */}
											<img
												src={faviconUrl(
													domain,
												)}
												alt=""
												width={14}
												height={14}
												className="rounded-sm flex-shrink-0"
												loading="lazy"
											/>
											{domain.replace(
												/^www\./,
												"",
											)}
											<span
												className="w-2 h-2 rounded-full animate-pulse"
												style={{
													background:
														"var(--color-accent)",
												}}
											/>
										</span>
									))
								: (
										<span
											className="inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px]"
											style={{
												background:
													"var(--color-surface-hover)",
												color: "var(--color-text-muted)",
												border: "1px solid var(--color-border)",
											}}
										>
											<span
												className="w-2 h-2 rounded-full animate-pulse"
												style={{
													background:
														"var(--color-accent)",
												}}
											/>
											{kind === "fetch"
												? "Fetching..."
												: "Searching..."}
										</span>
									)}
						</div>
					)}

				{status === "error" && resolvedErrorText && (
					<div
						className="mt-1.5 text-[12px] font-mono rounded-lg px-2.5 py-1.5"
						style={{
							color: "var(--color-error)",
							background:
								"color-mix(in srgb, var(--color-error) 6%, var(--color-surface))",
						}}
					>
						{resolvedErrorText}
					</div>
				)}

				{composioSearchCard && (
					<div
						className="mt-1.5 rounded-lg px-2.5 py-2"
						style={{
							background: "var(--color-bg)",
							border: "1px solid var(--color-border)",
						}}
					>
						<SummaryRow
							label="Results"
							value={composioSearchCard.resultSummary}
						/>
						{composioSearchCard.connectedToolkits && (
							<SummaryRow
								label="Connected"
								value={composioSearchCard.connectedToolkits}
							/>
						)}
						{composioSearchCard.topTools.length > 0 && (
							<SummaryRow
								label="Top matches"
								value={composioSearchCard.topTools.join(", ")}
							/>
						)}
						{composioSearchCard.accountSummary && (
							<SummaryRow
								label="Accounts"
								value={composioSearchCard.accountSummary}
							/>
						)}
						{composioSearchCard.schemaSummary && (
							<SummaryRow
								label="Schema"
								value={composioSearchCard.schemaSummary}
							/>
						)}
						{composioSearchCard.planSteps.length > 0 && (
							<SummaryRow
								label="Plan"
								value={composioSearchCard.planSteps.join(" -> ")}
							/>
						)}
						{composioSearchCard.pitfalls.length > 0 && (
							<SummaryRow
								label="Pitfalls"
								value={composioSearchCard.pitfalls.join(" | ")}
							/>
						)}
						{composioSearchCard.sessionId && (
							<SummaryRow
								label="Session"
								value={composioSearchCard.sessionId}
							/>
						)}
						{composioSearchCard.schemaText && (
							<details className="mt-2">
								<summary
									className="text-[11px] cursor-pointer"
									style={{ color: "var(--color-text-secondary)" }}
								>
									Schema details
								</summary>
								<pre
									className="mt-2 text-[11px] font-mono rounded-lg px-2.5 py-2 overflow-x-auto whitespace-pre-wrap break-all max-h-56 overflow-y-auto leading-relaxed"
									style={{
										color: "var(--color-text-muted)",
										background: "var(--color-surface-hover)",
									}}
								>
									{composioSearchCard.schemaText}
								</pre>
							</details>
						)}
					</div>
				)}

				{composioCallCard && (
					<div
						className="mt-1.5 rounded-lg px-2.5 py-2"
						style={{
							background: "var(--color-bg)",
							border: "1px solid var(--color-border)",
						}}
					>
						<SummaryRow
							label="Tool"
							value={
								composioCallCard.app
									? `${composioCallCard.app} / ${composioCallCard.toolName}`
									: composioCallCard.toolName
							}
						/>
						{composioCallCard.account && (
							<SummaryRow
								label="Account"
								value={composioCallCard.account}
							/>
						)}
						{composioCallCard.sessionId && (
							<SummaryRow
								label="Session"
								value={composioCallCard.sessionId}
							/>
						)}
						{composioCallCard.recoverySummary && (
							<SummaryRow
								label="Recovery"
								value={composioCallCard.recoverySummary}
							/>
						)}
						{composioCallCard.keyArgs.length > 0 && (
							<SummaryRow
								label="Args"
								value={composioCallCard.keyArgs.join(" | ")}
							/>
						)}
						{composioCallCard.pagination && (
							<SummaryRow
								label="Pagination"
								value={composioCallCard.pagination}
							/>
						)}
						{composioCallCard.resultSummary && (
							<SummaryRow
								label="Result"
								value={composioCallCard.resultSummary}
							/>
						)}
					</div>
				)}

				{/* Args summary — show for tools with no output/diff so they're never opaque */}
				{!outputText &&
					!diffText &&
					!isSingleMedia &&
					status !== "running" &&
					args &&
					Object.keys(args).length > 0 && (
						<pre
							className="mt-1 text-[11px] font-mono rounded-lg px-2.5 py-1.5 whitespace-pre-wrap break-all max-h-48 overflow-y-auto leading-relaxed"
							style={{
								color: "var(--color-text-muted)",
								background: "var(--color-bg)",
							}}
						>
							{formatArgs(args)}
						</pre>
					)}

				{/* Output toggle — show for completed tools, or partial output while running */}
				{outputText &&
					!isSingleMedia &&
					!diffText && (
						<div className="mt-1">
							{(showOutput || status === "running") && (
								<pre
									className="mt-1 text-[11px] font-mono rounded-lg px-2.5 py-2 overflow-x-auto whitespace-pre-wrap break-all max-h-96 overflow-y-auto leading-relaxed"
									style={{
										color: "var(--color-text-muted)",
										background: "var(--color-bg)",
									}}
								>
									{outputText.length > 10000
										? outputText.slice(0, 10000) +
											"\n... (truncated)"
										: outputText}
								</pre>
							)}
						</div>
					)}
			</div>
		</div>
	);
}

/* ─── Domain badge with favicon ─── */

function DomainBadge({ domain }: { domain: string }) {
	const short = domain.replace(/^www\./, "");
	return (
		<span
			className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12px]"
			style={{
				background: "var(--color-surface-hover)",
				color: "var(--color-text-secondary)",
				border: "1px solid var(--color-border)",
			}}
		>
			{/* eslint-disable-next-line @next/next/no-img-element */}
			<img
				src={faviconUrl(domain)}
				alt=""
				width={16}
				height={16}
				className="rounded-sm flex-shrink-0"
				loading="lazy"
			/>
			{short}
		</span>
	);
}

/* ─── Step icons ─── */

function StepIcon({ kind }: { kind: StepKind }) {
	const color = "var(--color-text-muted)";
	const size = 16;

	switch (kind) {
		case "composio":
			return (
				/* eslint-disable-next-line @next/next/no-img-element */
				<img src="/dench-integrations-icon.png" alt="" width={size} height={size} className="rounded-sm" />
			);
		case "search":
			return (
				<svg
					width={size}
					height={size}
					viewBox="0 0 24 24"
					fill="none"
					stroke={color}
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<circle cx="11" cy="11" r="8" />
					<path d="m21 21-4.3-4.3" />
				</svg>
			);
		case "fetch":
			return (
				<svg
					width={size}
					height={size}
					viewBox="0 0 24 24"
					fill="none"
					stroke={color}
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<circle cx="12" cy="12" r="10" />
					<path d="M2 12h20" />
					<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
				</svg>
			);
		case "read":
			return (
				<svg
					width={size}
					height={size}
					viewBox="0 0 24 24"
					fill="none"
					stroke={color}
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
					<path d="M14 2v4a2 2 0 0 0 2 2h4" />
				</svg>
			);
		case "exec":
			return (
				<svg
					width={size}
					height={size}
					viewBox="0 0 24 24"
					fill="none"
					stroke={color}
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<polyline points="4 17 10 11 4 5" />
					<line x1="12" x2="20" y1="19" y2="19" />
				</svg>
			);
		case "write":
			return (
				<svg
					width={size}
					height={size}
					viewBox="0 0 24 24"
					fill="none"
					stroke={color}
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
					<path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
				</svg>
			);
		case "image":
			return (
				<svg
					width={size}
					height={size}
					viewBox="0 0 24 24"
					fill="none"
					stroke={color}
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<rect
						width="18"
						height="18"
						x="3"
						y="3"
						rx="2"
						ry="2"
					/>
					<circle cx="9" cy="9" r="2" />
					<path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
				</svg>
			);
		default:
			return (
				<svg
					width={size}
					height={size}
					viewBox="0 0 24 24"
					fill="none"
					stroke={color}
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<circle cx="12" cy="12" r="1" />
				</svg>
			);
	}
}

function ErrorCircleIcon() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="var(--color-error)"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<circle cx="12" cy="12" r="10" />
			<line x1="15" x2="9" y1="9" y2="15" />
			<line x1="9" x2="15" y1="9" y2="15" />
		</svg>
	);
}

function PdfIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
			<path d="M14 2v4a2 2 0 0 0 2 2h4" />
			<path d="M10 9H8" />
			<path d="M16 13H8" />
			<path d="M16 17H8" />
		</svg>
	);
}

/* ─── Header icons ─── */

function ThinkingIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z" />
			<path d="M10 21h4" />
			<path d="M9 9.4a3 3 0 0 1 5.1-2" />
		</svg>
	);
}

function ChevronIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 12 12"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M3 4.5L6 7.5L9 4.5" />
		</svg>
	);
}
