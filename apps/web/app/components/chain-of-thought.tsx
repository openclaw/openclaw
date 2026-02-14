"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DiffCard } from "./diff-viewer";

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
	| {
			kind: "status";
			label: string;
			isActive: boolean;
		};

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

/* ─── Classify tool steps ─── */

type StepKind =
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
): StepKind {
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
		return "fetch"; // default: most browser actions involve a page
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
		{return "image";}
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
		case "search": {
			const q =
				strVal("query") ??
				strVal("search_query") ??
				strVal("search") ??
				strVal("q");
			return q
				? `Searching for ${q.length > 60 ? q.slice(0, 60) + "..." : q}`
				: "Searching...";
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
					return `Fetching ${u.length > 50 ? u.slice(0, 50) + "..." : u}`;
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
					return `Fetched ${outUrl.length > 50 ? outUrl.slice(0, 50) + "..." : outUrl}`;
				}
			}
			return "Fetching page";
		}
		case "read": {
			const p = getFilePath(args, output);
			if (p) {
				const short = p.split("/").pop() ?? p;
				return short.startsWith("http")
					? `Fetching ${short.slice(0, 50)}`
					: `Reading ${short}`;
			}
			return "Reading file";
		}
		case "exec": {
			const cmd = strVal("command") ?? strVal("cmd");
			if (cmd) {
				const short =
					cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
				return `Running: ${short}`;
			}
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
				? `Generating image: ${strVal("description")!.slice(0, 50)}`
				: "Generating image";
		default:
			return toolName
				.replace(/_/g, " ")
				.replace(/\b\w/g, (c) => c.toUpperCase())
				.trim();
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
		};

function groupToolSteps(tools: ToolPart[]): VisualItem[] {
	const result: VisualItem[] = [];
	let i = 0;
	while (i < tools.length) {
		const tool = tools[i];
		const kind = classifyTool(tool.toolName, tool.args);
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
				const nextKind = classifyTool(next.toolName, next.args);
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
		} else {
			result.push({ type: "tool", tool });
			i++;
		}
	}
	return result;
}

/* ─── Main component ─── */

export function ChainOfThought({ parts, isStreaming }: { parts: ChainPart[]; isStreaming?: boolean }) {
	const [isOpen, setIsOpen] = useState(true);

	const isActive = parts.some(
		(p) =>
			(p.kind === "reasoning" && p.isStreaming) ||
			(p.kind === "tool" && p.status === "running") ||
			(p.kind === "status" && p.isActive),
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

	const statusParts = parts.filter(
		(p): p is Extract<ChainPart, { kind: "status" }> =>
			p.kind === "status",
	);
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

	// Derive a more descriptive header from status parts
	const activeStatus = statusParts.find((s) => s.isActive);
	const headerLabel = isActive
		? activeStatus
			? elapsed > 0
				? `${activeStatus.label} ${formatDuration(elapsed)}`
				: activeStatus.label
			: elapsed > 0
				? `Thinking... ${formatDuration(elapsed)}`
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
				{isActive && (
					<span
						className="w-1.5 h-1.5 rounded-full animate-pulse flex-shrink-0"
						style={{ background: "var(--color-accent)" }}
					/>
				)}
				<ChevronIcon
					className={`w-3.5 h-3.5 ml-1 flex-shrink-0 transition-transform duration-200 ${
						isOpen ? "" : "-rotate-90"
					}`}
				/>
			</button>

			{/* Collapsible content */}
			<div
				className="grid transition-[grid-template-rows] duration-200 ease-out"
				style={{
					gridTemplateRows: isOpen ? "1fr" : "0fr",
				}}
			>
				<div className="overflow-hidden">
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
						{statusParts.map((sp, idx) => (
							<StatusStep
								key={`status-${idx}`}
								label={sp.label}
								isActive={sp.isActive}
							/>
						))}
						{reasoningText && (
							<div className="flex items-start gap-2.5 py-1.5">
								<div
									className="relative z-10 flex-shrink-0 w-5 h-5 mt-0.5 flex items-center justify-center rounded-full"
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
							</div>
						)}
						{visualItems.map((item, idx) => {
							if (item.type === "media-group") {
								return (
									<MediaGroup
										key={idx}
										mediaKind={item.mediaKind}
										items={item.items}
									/>
								);
							}
							return (
								<ToolStep
									key={item.tool.toolCallId}
									{...item.tool}
								/>
							);
						})}
					</div>
				</div>
			</div>
		</div>
	);
}

/* ─── Reasoning block ─── */

function ReasoningBlock({
	text,
	isStreaming,
}: {
	text: string;
	isStreaming: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const isLong = text.length > 400;

	return (
		<div className="mb-2">
			<div
				className={`text-[13px] whitespace-pre-wrap leading-relaxed ${
					!expanded && isLong
						? "max-h-24 overflow-hidden"
						: ""
				}`}
				style={{ color: "var(--color-text-secondary)" }}
			>
				{text}
				{isStreaming && (
					<span
						className="inline-block w-1 h-3.5 ml-0.5 animate-pulse align-text-bottom rounded-sm"
						style={{
							background: "var(--color-accent)",
						}}
					/>
				)}
			</div>
			{isLong && !expanded && (
				<button
					type="button"
					onClick={() => setExpanded(true)}
					className="text-[12px] hover:underline mt-1 cursor-pointer"
					style={{ color: "var(--color-accent)" }}
				>
					Show more
				</button>
			)}
		</div>
	);
}

/* ─── Status step (lifecycle / compaction indicators) ─── */

function StatusStep({
	label,
	isActive,
}: {
	label: string;
	isActive: boolean;
}) {
	return (
		<div className="flex items-center gap-2.5 py-1.5">
			<div
				className="relative z-10 flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-full"
				style={{ background: "var(--color-bg)" }}
			>
				{isActive ? (
					<span
						className="w-4 h-4 border-[1.5px] rounded-full animate-spin"
						style={{
							borderColor: "var(--color-border-strong)",
							borderTopColor: "var(--color-accent)",
						}}
					/>
				) : (
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="var(--color-success, var(--color-accent))"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M20 6 9 17l-5-5" />
					</svg>
				)}
			</div>
			<span
				className="text-[13px] leading-snug"
				style={{
					color: isActive
						? "var(--color-text)"
						: "var(--color-text-secondary)",
				}}
			>
				{label}
			</span>
		</div>
	);
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
				className="relative z-10 flex-shrink-0 w-5 h-5 mt-0.5 flex items-center justify-center rounded-full"
				style={{ background: "var(--color-bg)" }}
			>
				{anyRunning ? (
					<span
						className="w-4 h-4 border-[1.5px] rounded-full animate-spin"
						style={{
							borderColor: "var(--color-border-strong)",
							borderTopColor: "var(--color-accent)",
						}}
					/>
				) : (
					<StepIcon
						kind={
							mediaKind === "image"
								? "image"
								: "read"
						}
					/>
				)}
			</div>
			<div className="flex-1 min-w-0">
				<div
					className="text-[13px] leading-snug mb-1.5"
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
								<span
									className="w-4 h-4 border-[1.5px] rounded-full animate-spin"
									style={{
										borderColor:
											"var(--color-border-strong)",
										borderTopColor:
											"var(--color-accent)",
									}}
								/>
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
	const [showOutput, setShowOutput] = useState(false);
	// Auto-expand diffs for write tool steps
	const [showDiff, setShowDiff] = useState(true);
	const kind = classifyTool(toolName, args);
	const label = buildStepLabel(kind, toolName, args, output);
	const domains =
		kind === "search"
			? getSearchDomains(output)
			: kind === "fetch"
				? getFetchDomains(args, output)
				: [];
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
				className="relative z-10 flex-shrink-0 w-5 h-5 mt-0.5 flex items-center justify-center rounded-full"
				style={{ background: "var(--color-bg)" }}
			>
				{status === "running" ? (
					<span
						className="w-4 h-4 border-[1.5px] rounded-full animate-spin"
						style={{
							borderColor: "var(--color-border-strong)",
							borderTopColor: "var(--color-accent)",
						}}
					/>
				) : status === "error" ? (
					<ErrorCircleIcon />
				) : (
					<StepIcon kind={kind} />
				)}
			</div>

			<div className="flex-1 min-w-0">
				<div
					className="text-[13px] leading-snug"
					style={{
						color:
							status === "running"
								? "var(--color-text)"
								: "var(--color-text-secondary)",
					}}
				>
					{label}
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

				{status === "error" && errorText && (
					<div
						className="mt-1.5 text-[12px] font-mono rounded-lg px-2.5 py-1.5"
						style={{
							color: "var(--color-error)",
							background:
								"color-mix(in srgb, var(--color-error) 6%, var(--color-surface))",
						}}
					>
						{errorText}
					</div>
				)}

				{/* Output toggle — skip for media files, search, and diffs */}
				{outputText &&
					status === "done" &&
					kind !== "search" &&
					!isSingleMedia &&
					!diffText && (
						<div className="mt-1">
							<button
								type="button"
								onClick={() =>
									setShowOutput((v) => !v)
								}
								className="text-[11px] hover:underline cursor-pointer"
								style={{
									color: "var(--color-accent)",
								}}
							>
								{showOutput
									? "Hide output"
									: "Show output"}
							</button>
							{showOutput && (
								<pre
									className="mt-1 text-[11px] font-mono rounded-lg px-2.5 py-2 overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto leading-relaxed"
									style={{
										color: "var(--color-text-muted)",
										background: "var(--color-bg)",
									}}
								>
									{outputText.length > 2000
										? outputText.slice(0, 2000) +
											"\n..."
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
