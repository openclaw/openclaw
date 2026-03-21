"use client";

import dynamic from "next/dynamic";
import type { UIMessage } from "ai";
import posthog from "posthog-js";
import { useThumbSurvey } from "posthog-js/react/surveys";
import { memo, useCallback, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChainOfThought, type ChainPart } from "./chain-of-thought";
import { isStatusReasoningText } from "./chat-stream-status";
import { splitReportBlocks, hasReportBlocks } from "@/lib/report-blocks";
import { splitDiffBlocks, hasDiffBlocks } from "@/lib/diff-blocks";
import type { ReportConfig } from "./charts/types";
import { DiffCard } from "./diff-viewer";
import { SyntaxBlock } from "./syntax-block";

// Lazy-load ReportCard (uses Recharts which is heavy)
const ReportCard = dynamic(
	() =>
		import("./charts/report-card").then((m) => ({
			default: m.ReportCard,
		})),
	{
		ssr: false,
		loading: () => (
			<div
				className="h-48 rounded-2xl animate-pulse"
				style={{ background: "var(--color-surface-hover)" }}
			/>
		),
	},
);

/* ─── Silent-reply leak filter ─── */

const _SILENT_TOKEN = "NO_REPLY";

function isLeakedSilentToken(text: string): boolean {
	const t = text.trim();
	if (!t) {return false;}
	if (new RegExp(`^${_SILENT_TOKEN}\\W*$`).test(t)) {return true;}
	if (_SILENT_TOKEN.startsWith(t) && t.length >= 2 && t.length < _SILENT_TOKEN.length) {return true;}
	return false;
}

/* ─── Part grouping ─── */

type MessageSegment =
	| { type: "text"; text: string }
	| { type: "chain"; parts: ChainPart[] }
	| { type: "report-artifact"; config: ReportConfig }
	| { type: "diff-artifact"; diff: string }
	| { type: "subagent-card"; task: string; label?: string; sessionKey?: string; status: "running" | "done" | "error" };

/** Map AI SDK tool state string to a simplified status */
function toolStatus(
	state: string,
	preliminary = false,
): "running" | "done" | "error" {
	if (state === "output-error" || state === "error") {
		return "error";
	}
	if (state === "output-available" && !preliminary) {
		return "done";
	}
	return "running";
}

/**
 * Group consecutive non-text parts (reasoning + tools) into chain-of-thought
 * blocks, with text parts standing alone between them.
 */
function groupParts(parts: UIMessage["parts"]): MessageSegment[] {
	const segments: MessageSegment[] = [];
	let chain: ChainPart[] = [];

	const flush = (textFollows?: boolean) => {
		if (chain.length > 0) {
			// If text content follows this chain, all tools must have
			// completed — force any stuck "running" tools to "done".
			if (textFollows) {
				for (const cp of chain) {
					if (cp.kind === "tool" && cp.status === "running") {
						cp.status = "done";
					}
				}
			}
			segments.push({ type: "chain", parts: [...chain] });
			chain = [];
		}
	};

	for (const part of parts) {
		if (part.type === "text") {
			const text = (part as { type: "text"; text: string }).text;
			if (isLeakedSilentToken(text)) { continue; }
			flush(true);
			if (hasReportBlocks(text)) {
				segments.push(
					...(splitReportBlocks(text) as MessageSegment[]),
				);
			} else if (hasDiffBlocks(text)) {
				for (const seg of splitDiffBlocks(text)) {
					if (seg.type === "diff-artifact") {
						segments.push({ type: "diff-artifact", diff: seg.diff });
					} else {
						segments.push({ type: "text", text: seg.text });
					}
				}
			} else {
				segments.push({ type: "text", text });
			}
		} else if (part.type === "reasoning") {
			const rp = part as {
				type: "reasoning";
				text: string;
				state?: string;
			};
			// Skip lifecycle/compaction status labels in the thought body.
			// The active stream row renders them separately so they stay visible
			// without cluttering the permanent transcript.
			if (!isStatusReasoningText(rp.text)) {
				chain.push({
					kind: "reasoning",
					text: rp.text,
					isStreaming: rp.state === "streaming",
				});
			}
	} else if (part.type === "dynamic-tool") {
		const tp = part as {
			type: "dynamic-tool";
			toolName: string;
			toolCallId: string;
			state: string;
			input?: unknown;
			output?: unknown;
			preliminary?: boolean;
		};
		if (tp.toolName === "sessions_spawn") {
			flush(true);
			const args = asRecord(tp.input);
			const out = asRecord(tp.output);
			const task = typeof args?.task === "string" ? args.task : "Subagent task";
			const label = typeof args?.label === "string" ? args.label : undefined;
			const sessionKey = typeof out?.sessionKey === "string" ? out.sessionKey : undefined;
			segments.push({
				type: "subagent-card",
				task,
				label,
				sessionKey,
				status: toolStatus(tp.state, tp.preliminary === true),
			});
		} else {
			chain.push({
				kind: "tool",
				toolName: tp.toolName,
				toolCallId: tp.toolCallId,
				status: toolStatus(tp.state, tp.preliminary === true),
				args: asRecord(tp.input),
				output: asRecord(tp.output),
			});
		}
	} else if (part.type.startsWith("tool-")) {
		// Handles both live SSE parts (input/output fields) and
		// persisted JSONL parts (args/result fields from tool-invocation)
		const tp = part as {
			type: string;
			toolCallId: string;
			toolName?: string;
			state?: string;
			title?: string;
			input?: unknown;
			output?: unknown;
			// Persisted JSONL format uses args/result instead
			args?: unknown;
			result?: unknown;
			errorText?: string;
			preliminary?: boolean;
		};
		const resolvedToolName = tp.title ?? tp.toolName ?? part.type.replace("tool-", "");
		if (resolvedToolName === "sessions_spawn") {
			flush(true);
			const args = asRecord(tp.input) ?? asRecord(tp.args);
			const out = asRecord(tp.output) ?? asRecord(tp.result);
			const task = typeof args?.task === "string" ? args.task : "Subagent task";
			const label = typeof args?.label === "string" ? args.label : undefined;
			const sessionKey = typeof out?.sessionKey === "string" ? out.sessionKey : undefined;
			const resolvedState =
				tp.state ??
				(tp.errorText ? "output-error" : ("result" in tp || "output" in tp) ? "output-available" : "input-available");
			segments.push({
				type: "subagent-card",
				task,
				label,
				sessionKey,
				status: toolStatus(resolvedState, tp.preliminary === true),
			});
		} else {
			// Persisted tool-invocation parts have no state field but
			// include result/output/errorText to indicate completion.
			const resolvedState =
				tp.state ??
				(tp.errorText ? "output-error" : ("result" in tp || "output" in tp) ? "output-available" : "input-available");
			chain.push({
				kind: "tool",
				toolName: resolvedToolName,
				toolCallId: tp.toolCallId,
				status: toolStatus(resolvedState, tp.preliminary === true),
				args: asRecord(tp.input) ?? asRecord(tp.args),
				output: asRecord(tp.output) ?? asRecord(tp.result),
			});
		}
	}
	}

	flush();
	return segments;
}

/** Safely cast unknown to Record if it's a non-null object */
function asRecord(
	val: unknown,
): Record<string, unknown> | undefined {
	if (val && typeof val === "object" && !Array.isArray(val)) {
		return val as Record<string, unknown>;
	}
	return undefined;
}

/* ─── Attachment parsing for sent messages ─── */

function parseAttachments(
	text: string,
): { paths: string[]; message: string } | null {
	const match = text.match(/\[Attached files: (.+?)\]/);
	if (!match) {return null;}
	const afterIdx = (match.index ?? 0) + match[0].length;
	const message = text.slice(afterIdx).trim();
	const paths = match[1]
		.split(", ")
		.map((p) => p.trim())
		.filter(Boolean);
	return { paths, message };
}

function getCategoryFromPath(
	filePath: string,
): "image" | "video" | "audio" | "pdf" | "code" | "document" | "other" {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	if (
		[
			"jpg", "jpeg", "png", "gif", "webp", "svg", "bmp",
			"ico", "tiff", "heic",
		].includes(ext)
	)
		{return "image";}
	if (["mp4", "webm", "mov", "avi", "mkv", "flv"].includes(ext))
		{return "video";}
	if (["mp3", "wav", "ogg", "aac", "flac", "m4a"].includes(ext))
		{return "audio";}
	if (ext === "pdf") {return "pdf";}
	if (
		[
			"js", "ts", "tsx", "jsx", "py", "rb", "go", "rs",
			"java", "cpp", "c", "h", "css", "html", "json",
			"yaml", "yml", "toml", "md", "sh", "bash", "sql",
			"swift", "kt",
		].includes(ext)
	)
		{return "code";}
	if (
		[
			"doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt",
			"rtf", "csv", "pages", "numbers", "key",
		].includes(ext)
	)
		{return "document";}
	return "other";
}

function _shortenPath(path: string): string {
	return path
		.replace(/^\/Users\/[^/]+/, "~")
		.replace(/^\/home\/[^/]+/, "~")
		.replace(/^[A-Z]:\\Users\\[^\\]+/, "~");
}

const _attachCategoryMeta: Record<string, { bg: string; fg: string }> = {
	image: { bg: "rgba(16, 185, 129, 0.15)", fg: "#10b981" },
	video: { bg: "rgba(139, 92, 246, 0.15)", fg: "#8b5cf6" },
	audio: { bg: "rgba(245, 158, 11, 0.15)", fg: "#f59e0b" },
	pdf: { bg: "rgba(239, 68, 68, 0.15)", fg: "#ef4444" },
	code: { bg: "rgba(59, 130, 246, 0.15)", fg: "#3b82f6" },
	document: { bg: "rgba(107, 114, 128, 0.15)", fg: "#6b7280" },
	other: { bg: "rgba(107, 114, 128, 0.10)", fg: "#9ca3af" },
};

function _AttachFileIcon({ category }: { category: string }) {
	const props = {
		width: 14,
		height: 14,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 2,
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
	};
	switch (category) {
		case "image":
			return (
				<svg {...props}>
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
		case "video":
			return (
				<svg {...props}>
					<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />
					<rect x="2" y="6" width="14" height="12" rx="2" />
				</svg>
			);
		case "audio":
			return (
				<svg {...props}>
					<path d="M9 18V5l12-2v13" />
					<circle cx="6" cy="18" r="3" />
					<circle cx="18" cy="16" r="3" />
				</svg>
			);
		case "pdf":
			return (
				<svg {...props}>
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
					<path d="M14 2v6h6" />
					<path d="M10 13h4" />
					<path d="M10 17h4" />
				</svg>
			);
		case "code":
			return (
				<svg {...props}>
					<polyline points="16 18 22 12 16 6" />
					<polyline points="8 6 2 12 8 18" />
				</svg>
			);
		case "document":
			return (
				<svg {...props}>
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
					<path d="M14 2v6h6" />
					<path d="M16 13H8" />
					<path d="M16 17H8" />
					<path d="M10 9H8" />
				</svg>
			);
		default:
			return (
				<svg {...props}>
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
					<path d="M14 2v6h6" />
				</svg>
			);
	}
}

function AttachedFilesCard({ paths }: { paths: string[] }) {
	return (
		<div className="flex flex-wrap gap-1.5 mb-2 justify-end">
			{paths.map((filePath, i) => {
				const category = getCategoryFromPath(filePath);
				const src = category === "image"
					? `/api/workspace/raw-file?path=${encodeURIComponent(filePath)}`
					: `/api/workspace/thumbnail?path=${encodeURIComponent(filePath)}&size=200`;
				const ext = filePath.split(".").pop()?.toUpperCase() ?? "";

				return (
					<div
						key={i}
						className="relative rounded-xl overflow-hidden shrink-0"
					>
						<img
							src={src}
							alt={filePath.split("/").pop() ?? ""}
							className="block rounded-xl object-cover"
							style={{ maxHeight: 140, maxWidth: 160, background: "rgba(0,0,0,0.04)" }}
							loading="lazy"
							onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
						/>
						{category !== "image" && (
							<span
								className="absolute bottom-2 left-2 rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase"
								style={{
									background: "rgba(255,255,255,0.85)",
									color: "rgba(0,0,0,0.5)",
									backdropFilter: "blur(4px)",
								}}
							>
								{ext}
							</span>
						)}
					</div>
				);
			})}
		</div>
	);
}

/* ─── File path detection for clickable inline code ─── */

/**
 * Detect whether an inline code string looks like a local file/directory path.
 * Matches anything starting with:
 *   ~/   (home-relative)
 *   /    (absolute)
 *   ./   (current-dir-relative)
 *   ../  (parent-dir-relative)
 * Must contain at least one `/` separator to distinguish from plain commands.
 */
function looksLikeFilePath(text: string): boolean {
	const t = text.trim();
	if (!t || t.length < 3 || t.length > 500) {return false;}
	// Full path prefix
	if (t.startsWith("~/") || t.startsWith("/") || t.startsWith("./") || t.startsWith("../")) {
		const afterPrefix = t.startsWith("~/") ? t.slice(2) :
			t.startsWith("../") ? t.slice(3) :
			t.startsWith("./") ? t.slice(2) :
			t.slice(1);
		return afterPrefix.includes("/") || afterPrefix.includes(".");
	}
	// Bare filename with a known extension (e.g. "Rachapoom-Passport.pdf")
	const fileExtPattern = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|rtf|pages|numbers|key|md|json|yaml|yml|toml|xml|html?|css|jsx?|tsx?|py|rb|go|rs|java|cpp|c|h|sh|sql|swift|kt|png|jpe?g|gif|webp|svg|bmp|ico|heic|tiff|mp[34]|webm|mov|avi|mkv|flv|wav|ogg|aac|flac|m4a|zip|tar|gz|dmg)$/i;
	if (fileExtPattern.test(t) && !t.includes(" ")) {
		return true;
	}
	return false;
}

/** Check if text looks like a filename (allows spaces, used for bold text). */
function looksLikeFileName(text: string): boolean {
	const t = text.trim();
	if (!t || t.length < 3 || t.length > 300) {return false;}
	const fileExtPattern = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|rtf|pages|numbers|key|md|json|yaml|yml|toml|xml|html?|css|jsx?|tsx?|py|rb|go|rs|java|cpp|c|h|sh|sql|swift|kt|png|jpe?g|gif|webp|svg|bmp|ico|heic|tiff|mp[34]|webm|mov|avi|mkv|flv|wav|ogg|aac|flac|m4a|zip|tar|gz|dmg)$/i;
	return fileExtPattern.test(t);
}

/** Open a file path using the system default application. */
async function openFilePath(path: string, reveal = false) {
	try {
		const res = await fetch("/api/workspace/open-file", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path, reveal }),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			console.error("Failed to open file:", data);
		}
	} catch (err) {
		console.error("Failed to open file:", err);
	}
}

type FilePathClickHandler = (
	path: string,
) => Promise<boolean | void> | boolean | void;

/** Convert file:// URLs to local paths for in-app preview routing. */
function normalizePathReference(value: string): string {
	const trimmed = value.trim();
	if (!trimmed.startsWith("file://")) {
		return trimmed;
	}
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "file:") {
			return trimmed;
		}
		const decoded = decodeURIComponent(url.pathname);
		// Windows file URLs are /C:/... in URL form
		if (/^\/[A-Za-z]:\//.test(decoded)) {
			return decoded.slice(1);
		}
		return decoded;
	} catch {
		return trimmed;
	}
}

/** Clickable file path inline code element */
function FilePathCode({
	path,
	children,
	onFilePathClick,
}: {
	path: string;
	children: React.ReactNode;
	onFilePathClick?: FilePathClickHandler;
}) {
	const [status, setStatus] = useState<"idle" | "opening" | "error">("idle");

	const handleClick = async (e: React.MouseEvent) => {
		e.preventDefault();
		setStatus("opening");
		try {
			if (onFilePathClick) {
				const handled = await onFilePathClick(path);
				if (handled === false) {
					setStatus("error");
					setTimeout(() => setStatus("idle"), 2000);
					return;
				}
				setStatus("idle");
			} else {
				const res = await fetch("/api/workspace/open-file", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ path }),
				});
				if (!res.ok) {
					setStatus("error");
					setTimeout(() => setStatus("idle"), 2000);
				} else {
					setStatus("idle");
				}
			}
		} catch {
			setStatus("error");
			setTimeout(() => setStatus("idle"), 2000);
		}
	};

	const handleContextMenu = async (e: React.MouseEvent) => {
		// Right-click reveals in Finder instead of opening
		e.preventDefault();
		await openFilePath(path, true);
	};

	return (
		<code
			className={`px-[0.3em] no-underline transition-colors duration-150 rounded-[4px] border border-[color:var(--color-border)] bg-white/20 hover:bg-white/40 active:bg-white ${status === "opening" ? "cursor-wait opacity-70" : "cursor-pointer"}`}
			style={{ color: "var(--color-accent)" }}
			onClick={handleClick}
			onContextMenu={handleContextMenu}
			title={
				status === "error"
					? "File not found"
					: onFilePathClick
						? "Click to preview in workspace · Right-click to reveal in Finder"
						: "Click to open · Right-click to reveal in Finder"
			}
		>
			{children}
		</code>
	);
}

/* ─── Markdown component overrides for chat ─── */

function createMarkdownComponents(
	onFilePathClick?: FilePathClickHandler,
): Components {
	return {
		// Open external links in new tab; intercept local file-path links
		a: ({ href, children, ...props }) => {
			const rawHref = typeof href === "string" ? href : "";
			const normalizedHref = normalizePathReference(rawHref);
			const isExternal =
				rawHref && (rawHref.startsWith("http://") || rawHref.startsWith("https://") || rawHref.startsWith("//"));
			const isWorkspaceAppLink = rawHref.startsWith("/workspace") || rawHref.startsWith("/?");
			const isLocalPathLink =
				!isWorkspaceAppLink &&
				(Boolean(rawHref.startsWith("file://")) ||
					looksLikeFilePath(normalizedHref));
			return (
				<a
					href={href}
					{...(isExternal
						? { target: "_blank", rel: "noopener noreferrer" }
						: {})}
					{...props}
					onClick={(e) => {
						if (!isLocalPathLink || !onFilePathClick) {return;}
						e.preventDefault();
						void onFilePathClick(normalizedHref);
					}}
				>
					{children}
				</a>
			);
		},
		// Route local image paths through raw-file API so workspace images render
		img: ({ src, alt, ...props }) => {
			const resolvedSrc = typeof src === "string" && !src.startsWith("http://") && !src.startsWith("https://") && !src.startsWith("data:")
				? `/api/workspace/raw-file?path=${encodeURIComponent(src)}`
				: src;
			return (
				// eslint-disable-next-line @next/next/no-img-element
				<img src={resolvedSrc} alt={alt ?? ""} loading="lazy" {...props} />
			);
		},
		// Syntax-highlighted fenced code blocks
		pre: ({ children, ...props }) => {
			const child = Array.isArray(children) ? children[0] : children;
			if (
				child &&
				typeof child === "object" &&
				"type" in child &&
				(child as { type?: string }).type === "code"
			) {
				const codeEl = child as {
					props?: {
						className?: string;
						children?: string;
					};
				};
				const className = codeEl.props?.className ?? "";
				const langMatch = className.match(/language-(\w+)/);
				const lang = langMatch?.[1] ?? "";
				const code =
					typeof codeEl.props?.children === "string"
						? codeEl.props.children.replace(/\n$/, "")
						: "";

				// Diff language: render as DiffCard
				if (lang === "diff") {
					return <DiffCard diff={code} />;
				}

				// Known language: syntax-highlight with shiki
				if (lang) {
					return (
						<div className="chat-code-block">
							<div
								className="chat-code-lang"
							>
								{lang}
							</div>
							<SyntaxBlock code={code} lang={lang} />
						</div>
					);
				}
			}
			// Fallback: default pre rendering
			return <pre {...props}>{children}</pre>;
		},
		// Inline code — detect file paths and make them clickable
		code: ({ children, className, ...props }) => {
			// If this code has a language class, it's inside a <pre> and
			// will be handled by the pre override above. Just return raw.
			if (className?.startsWith("language-")) {
				return (
					<code className={className} {...props}>
						{children}
					</code>
				);
			}

			// Check if the inline code content looks like a file path
			const text = typeof children === "string" ? children : "";
			const normalizedText = normalizePathReference(text);
			if (normalizedText && looksLikeFilePath(normalizedText)) {
				return (
					<FilePathCode path={normalizedText} onFilePathClick={onFilePathClick}>
						{children}
					</FilePathCode>
				);
			}

			// Regular inline code
			return <code {...props}>{children}</code>;
		},
		// Bold text — detect filenames and make them clickable
		strong: ({ children, ...props }) => {
			const text = typeof children === "string" ? children
				: Array.isArray(children) ? children.filter((c) => typeof c === "string").join("")
				: "";
			if (text && looksLikeFileName(text)) {
				return (
					<strong {...props}>
						<FilePathCode path={text} onFilePathClick={onFilePathClick}>
							{children}
						</FilePathCode>
					</strong>
				);
			}
			return <strong {...props}>{children}</strong>;
		},
	};
}

/* ─── Feedback buttons (thumbs up / down) ─── */

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY || "";
const FEEDBACK_SURVEY_ID = "019cc021-a8bf-0000-d41d-b82956ef7e6a";

function FeedbackButtons({ messageId, sessionId }: { messageId: string; sessionId?: string | null }) {
	const revealTrace = useCallback((sid: string | null | undefined, mid: string) => {
		if (!sid) return;
		fetch("/api/feedback", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionId: sid,
				messageId: mid,
				distinctId: posthog.get_distinct_id?.(),
			}),
		}).catch(() => {});
	}, []);

	const { respond, response, triggerRef } = useThumbSurvey({
		surveyId: FEEDBACK_SURVEY_ID,
		properties: {
			$ai_trace_id: sessionId,
			message_id: messageId,
		},
		onResponse: () => revealTrace(sessionId, messageId),
	});

	const btnBase = "p-1 rounded-md transition-colors";

	return (
		<div ref={triggerRef} className="flex items-center gap-0.5 mt-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
			<button
				type="button"
				onClick={() => respond("up")}
				className={btnBase}
				style={{
					color: response === "up" ? "var(--color-accent)" : "var(--color-text-muted)",
				}}
				title="Good response"
				aria-label="Thumbs up"
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill={response === "up" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
					<path d="M7 10v12" /><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
				</svg>
			</button>
			<button
				type="button"
				onClick={() => respond("down")}
				className={btnBase}
				style={{
					color: response === "down" ? "var(--color-error, #ef4444)" : "var(--color-text-muted)",
				}}
				title="Bad response"
				aria-label="Thumbs down"
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill={response === "down" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
					<path d="M17 14V2" /><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
				</svg>
			</button>
		</div>
	);
}

/* ─── Chat message ─── */

export const ChatMessage = memo(function ChatMessage({ message, isStreaming, onSubagentClick, onFilePathClick, sessionId, userHtmlMap }: { message: UIMessage; isStreaming?: boolean; onSubagentClick?: (task: string) => void; onFilePathClick?: FilePathClickHandler; sessionId?: string | null; userHtmlMap?: Map<string, string> }) {
	const isUser = message.role === "user";
	const segments = groupParts(message.parts);
	const markdownComponents = useMemo(
		() => createMarkdownComponents(onFilePathClick),
		[onFilePathClick],
	);

	if (isUser) {
		const textContent = segments
			.filter(
				(s): s is { type: "text"; text: string } =>
					s.type === "text",
			)
			.map((s) => s.text)
			.join("\n");

		const attachmentInfo = parseAttachments(textContent);

		// Extract inline image parts (FileUIPart with image/* mediaType)
		const inlineImages = message.parts.filter(
			(p): p is { type: "file"; mediaType: string; url: string; filename?: string } =>
				(p as Record<string, unknown>).type === "file" &&
				typeof (p as Record<string, unknown>).mediaType === "string" &&
				((p as Record<string, unknown>).mediaType as string).startsWith("image/") &&
				typeof (p as Record<string, unknown>).url === "string",
		);

		const hasImages = inlineImages.length > 0;
		const hasPathAttachments = !!attachmentInfo;

		const richHtml = userHtmlMap?.get(message.id) ?? userHtmlMap?.get(textContent) ?? userHtmlMap?.get(attachmentInfo?.message ?? "");

		const displayText = attachmentInfo?.message ?? textContent;
		const bubbleContent = richHtml
			? <div className="chat-user-html-content" dangerouslySetInnerHTML={{ __html: richHtml }} />
			: displayText ? <p className="whitespace-pre-wrap break-words">{displayText}</p> : null;

		if (hasImages || hasPathAttachments) {
			return (
				<div className="flex flex-col items-end gap-1.5 py-2">
					{hasPathAttachments && <AttachedFilesCard paths={attachmentInfo.paths} />}
					{hasImages && (
						<div className="flex flex-wrap gap-1.5 justify-end">
							{inlineImages.map((img, i) => (
								<div key={i} className="relative rounded-xl overflow-hidden shrink-0">
									<img
										src={img.url}
										alt={img.filename ?? "Attached image"}
										className="block rounded-xl object-cover"
										style={{ maxHeight: 200, maxWidth: 240, background: "rgba(0,0,0,0.04)" }}
										loading="lazy"
									/>
								</div>
							))}
						</div>
					)}
					{(displayText || richHtml) && (
						<div
							className="max-w-[80%] w-fit rounded-2xl rounded-br-sm px-3 py-2 text-sm leading-6 break-words chat-message-font"
							style={{
								background: "var(--color-user-bubble)",
								color: "var(--color-user-bubble-text)",
							}}
						>
							{bubbleContent}
						</div>
					)}
				</div>
			);
		}

		return (
			<div className="flex justify-end py-2">
				<div
					className="max-w-[80%] min-w-0 rounded-2xl rounded-br-sm px-3 py-2 text-sm leading-6 overflow-hidden break-words chat-message-font"
					style={{
						background: "var(--color-user-bubble)",
						color: "var(--color-user-bubble-text)",
					}}
				>
					{bubbleContent}
				</div>
			</div>
		);
	}

	// Assistant: free-flowing text, left-aligned, NO bubble
	return (
		<div className="py-3 space-y-2 min-w-0 overflow-hidden group">
			<AnimatePresence initial={false}>
			{segments.map((segment, index) => {
				if (segment.type === "text") {
					// Detect agent error messages
					const errorMatch = segment.text.match(
						/^\[error\]\s*([\s\S]*)$/,
					);
					if (errorMatch) {
						return (
							<div
								key={index}
								className="chat-message-font flex items-start gap-2 rounded-xl px-3 py-2 text-[13px] leading-relaxed overflow-hidden"
								style={{
									background: `color-mix(in srgb, var(--color-error) 6%, var(--color-surface))`,
									color: "var(--color-error)",
									border: `1px solid color-mix(in srgb, var(--color-error) 18%, transparent)`,
								}}
							>
								<span
									className="flex-shrink-0 mt-0.5"
									aria-hidden="true"
								>
									<svg
										width="16"
										height="16"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<circle
											cx="12"
											cy="12"
											r="10"
										/>
										<line
											x1="12"
											y1="8"
											x2="12"
											y2="12"
										/>
										<line
											x1="12"
											y1="16"
											x2="12.01"
											y2="16"
										/>
									</svg>
								</span>
								<span className="whitespace-pre-wrap break-all min-w-0">
									{errorMatch[1].trim()}
								</span>
							</div>
						);
					}

				return (
			<motion.div
				key={`text-${index}`}
				initial={{ opacity: 0, y: 4 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.2, ease: "easeOut" }}
				className="chat-prose chat-message-font text-sm"
				style={{ color: "var(--color-text)" }}
			>
				<ReactMarkdown
					remarkPlugins={[remarkGfm]}
					components={markdownComponents}
				>
					{segment.text}
				</ReactMarkdown>
			</motion.div>
				);
				}
			if (segment.type === "report-artifact") {
				return (
					<motion.div
						key={`report-${index}`}
						initial={{ opacity: 0, y: 4 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.2, ease: "easeOut" }}
					>
						<ReportCard config={segment.config} />
					</motion.div>
				);
			}
		if (segment.type === "diff-artifact") {
			return (
				<motion.div
					key={`diff-${index}`}
					initial={{ opacity: 0, y: 4 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.2, ease: "easeOut" }}
				>
					<DiffCard diff={segment.diff} />
				</motion.div>
			);
		}
		if (segment.type === "subagent-card") {
			const truncatedTask = segment.task.length > 80 ? segment.task.slice(0, 80) + "..." : segment.task;
			const isRunning = segment.status === "running";
			return (
				<motion.div
					key={`subagent-${index}`}
					initial={{ opacity: 0, y: 4 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.2, ease: "easeOut" }}
				>
					<button
						type="button"
						onClick={() => onSubagentClick?.(segment.sessionKey ?? segment.task)}
						className="w-full text-left rounded-xl px-3.5 py-2.5 transition-colors cursor-pointer"
						style={{
							background: "var(--color-accent-light)",
							border: "1px solid color-mix(in srgb, var(--color-accent) 20%, transparent)",
						}}
					>
						<div className="flex items-center gap-2.5">
							{isRunning ? (
								<span
									className="inline-block w-2 h-2 rounded-full animate-pulse flex-shrink-0"
									style={{ background: "var(--color-accent)" }}
								/>
							) : (
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0" style={{ color: "var(--color-accent)" }}>
									<path d="M16 3h5v5" /><path d="m21 3-7 7" /><path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
								</svg>
							)}
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--color-accent)" }}>
										{isRunning ? "Running Subagent" : "Subagent"}
									</span>
								</div>
								<p className="text-xs mt-0.5 leading-relaxed" style={{ color: "var(--color-text)" }}>
									{segment.label || truncatedTask}
								</p>
							</div>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 opacity-40" style={{ color: "var(--color-text)" }}>
								<path d="m9 18 6-6-6-6" />
							</svg>
						</div>
					</button>
				</motion.div>
			);
		}
			return (
				<motion.div
					key={`chain-${index}`}
					initial={{ opacity: 0, y: 4 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.2, ease: "easeOut" }}
				>
					<ChainOfThought
						parts={segment.parts}
						isStreaming={isStreaming}
					/>
				</motion.div>
			);
			})}
			</AnimatePresence>
			{!isStreaming && POSTHOG_KEY && <FeedbackButtons messageId={message.id} sessionId={sessionId} />}
		</div>
	);
});
