"use client";

import dynamic from "next/dynamic";
import type { UIMessage } from "ai";
import { memo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChainOfThought, type ChainPart } from "./chain-of-thought";
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

/* ─── Part grouping ─── */

type MessageSegment =
	| { type: "text"; text: string }
	| { type: "chain"; parts: ChainPart[] }
	| { type: "report-artifact"; config: ReportConfig }
	| { type: "diff-artifact"; diff: string };

/** Map AI SDK tool state string to a simplified status */
function toolStatus(state: string): "running" | "done" | "error" {
	if (state === "output-available") {
		return "done";
	}
	if (state === "error") {
		return "error";
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
			flush(true);
			const text = (part as { type: "text"; text: string }).text;
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
			// Skip lifecycle/compaction status labels — they add noise
			// (e.g. "Preparing response...", "Optimizing session context...")
			const statusLabels = [
				"Preparing response...",
				"Optimizing session context...",
			];
			const isStatus = statusLabels.some((l) =>
				rp.text.startsWith(l),
			);
			if (!isStatus) {
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
			};
			chain.push({
				kind: "tool",
				toolName: tp.toolName,
				toolCallId: tp.toolCallId,
				status: toolStatus(tp.state),
				args: asRecord(tp.input),
				output: asRecord(tp.output),
			});
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
			};
			// Persisted tool-invocation parts have no state field but
			// include result/output/errorText to indicate completion.
			const resolvedState =
				tp.state ??
				(tp.errorText ? "error" : ("result" in tp || "output" in tp) ? "output-available" : "input-available");
			chain.push({
				kind: "tool",
				toolName:
					tp.title ??
					tp.toolName ??
					part.type.replace("tool-", ""),
				toolCallId: tp.toolCallId,
				status: toolStatus(resolvedState),
				args: asRecord(tp.input) ?? asRecord(tp.args),
				output: asRecord(tp.output) ?? asRecord(tp.result),
			});
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

function shortenPath(path: string): string {
	return path
		.replace(/^\/Users\/[^/]+/, "~")
		.replace(/^\/home\/[^/]+/, "~")
		.replace(/^[A-Z]:\\Users\\[^\\]+/, "~");
}

const attachCategoryMeta: Record<string, { bg: string; fg: string }> = {
	image: { bg: "rgba(16, 185, 129, 0.15)", fg: "#10b981" },
	video: { bg: "rgba(139, 92, 246, 0.15)", fg: "#8b5cf6" },
	audio: { bg: "rgba(245, 158, 11, 0.15)", fg: "#f59e0b" },
	pdf: { bg: "rgba(239, 68, 68, 0.15)", fg: "#ef4444" },
	code: { bg: "rgba(59, 130, 246, 0.15)", fg: "#3b82f6" },
	document: { bg: "rgba(107, 114, 128, 0.15)", fg: "#6b7280" },
	other: { bg: "rgba(107, 114, 128, 0.10)", fg: "#9ca3af" },
};

function AttachFileIcon({ category }: { category: string }) {
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
		<div className="mb-2">
			<div className="flex items-center gap-1.5 mb-2">
				<svg
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					style={{ opacity: 0.5 }}
				>
					<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
				</svg>
				<span
					className="text-[11px] font-medium uppercase tracking-wider"
					style={{ opacity: 0.5 }}
				>
					{paths.length}{" "}
					{paths.length === 1 ? "file" : "files"}{" "}
					attached
				</span>
			</div>
			<div className="flex flex-wrap gap-1.5">
				{paths.map((filePath, i) => {
					const category =
						getCategoryFromPath(filePath);
					const filename =
						filePath.split("/").pop() ??
						filePath;
					const meta =
						attachCategoryMeta[category] ??
						attachCategoryMeta.other;
					const short = shortenPath(filePath);

					return (
						<div
							key={i}
							className="flex-shrink-0 rounded-lg"
							style={{
								background:
									"rgba(0,0,0,0.04)",
								border: "1px solid rgba(0,0,0,0.06)",
							}}
						>
							<div className="flex items-center gap-2 px-2.5 py-1.5">
								<div
									className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
									style={{
										background:
											meta.bg,
										color: meta.fg,
									}}
								>
									<AttachFileIcon
										category={
											category
										}
									/>
								</div>
								<div className="min-w-0">
									<p
										className="text-[12px] font-medium truncate max-w-[160px]"
										title={
											filePath
										}
									>
										{filename}
									</p>
									<p
										className="text-[10px] truncate max-w-[160px]"
										style={{
											opacity: 0.45,
										}}
										title={
											filePath
										}
									>
										{short}
									</p>
								</div>
							</div>
						</div>
					);
				})}
			</div>
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
	// Must start with a path prefix
	if (!(t.startsWith("~/") || t.startsWith("/") || t.startsWith("./") || t.startsWith("../"))) {
		return false;
	}
	// Must have at least one path separator beyond the prefix
	// (avoids matching bare `/` or standalone commands like `/bin`)
	const afterPrefix = t.startsWith("~/") ? t.slice(2) :
		t.startsWith("../") ? t.slice(3) :
		t.startsWith("./") ? t.slice(2) :
		t.slice(1);
	return afterPrefix.includes("/") || afterPrefix.includes(".");
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

/** Clickable file path inline code element */
function FilePathCode({
	path,
	children,
}: {
	path: string;
	children: React.ReactNode;
}) {
	const [status, setStatus] = useState<"idle" | "opening" | "error">("idle");

	const handleClick = async (e: React.MouseEvent) => {
		e.preventDefault();
		setStatus("opening");
		try {
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
			className={`inline-flex items-center gap-[0.2em] px-[0.3em] py-0 whitespace-nowrap max-w-full overflow-hidden text-ellipsis no-underline transition-colors duration-150 rounded-md text-[color:var(--color-accent)] border border-[color:var(--color-border)] bg-white/20 hover:bg-white/40 active:bg-white ${status === "opening" ? "cursor-wait opacity-70" : "cursor-pointer"}`}
			onClick={handleClick}
			onContextMenu={handleContextMenu}
			title={status === "error" ? "File not found" : "Click to open · Right-click to reveal in Finder"}
		>
			<svg
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				className="shrink-0 opacity-60"
			>
				{status === "error" ? (
					<>
						<circle cx="12" cy="12" r="10" />
						<line x1="15" x2="9" y1="9" y2="15" />
						<line x1="9" x2="15" y1="9" y2="15" />
					</>
				) : (
					<>
						<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
						<path d="M14 2v4a2 2 0 0 0 2 2h4" />
					</>
				)}
			</svg>
			{children}
		</code>
	);
}

/* ─── Markdown component overrides for chat ─── */

const mdComponents: Components = {
	// Open external links in new tab
	a: ({ href, children, ...props }) => {
		const isExternal =
			href && (href.startsWith("http") || href.startsWith("//"));
		return (
			<a
				href={href}
				{...(isExternal
					? { target: "_blank", rel: "noopener noreferrer" }
					: {})}
				{...props}
			>
				{children}
			</a>
		);
	},
	// Render images with loading=lazy
	img: ({ src, alt, ...props }) => (
		// eslint-disable-next-line @next/next/no-img-element
		<img src={src} alt={alt ?? ""} loading="lazy" {...props} />
	),
	// Syntax-highlighted fenced code blocks
	pre: ({ children, ...props }) => {
		// react-markdown wraps code blocks in <pre><code>...
		// Extract the code element to get lang + content
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
		if (text && looksLikeFilePath(text)) {
			return <FilePathCode path={text}>{children}</FilePathCode>;
		}

		// Regular inline code
		return <code {...props}>{children}</code>;
	},
};

/* ─── Chat message ─── */

export const ChatMessage = memo(function ChatMessage({ message, isStreaming }: { message: UIMessage; isStreaming?: boolean }) {
	const isUser = message.role === "user";
	const segments = groupParts(message.parts);

	if (isUser) {
		// User: right-aligned subtle pill
		const textContent = segments
			.filter(
				(s): s is { type: "text"; text: string } =>
					s.type === "text",
			)
			.map((s) => s.text)
			.join("\n");

		// Parse attachment prefix from sent messages
		const attachmentInfo = parseAttachments(textContent);

		return (
			<div className="flex justify-end py-2">
				<div
					className="font-bookerly max-w-[80%] min-w-0 rounded-2xl rounded-br-sm px-3 py-2 text-sm leading-6 overflow-hidden break-all"
					style={{
						background: "var(--color-user-bubble)",
						color: "var(--color-user-bubble-text)",
					}}
				>
					{attachmentInfo ? (
						<>
							<AttachedFilesCard
								paths={
									attachmentInfo.paths
								}
							/>
							{attachmentInfo.message && (
								<p className="whitespace-pre-wrap break-all">
									{
										attachmentInfo.message
									}
								</p>
							)}
						</>
					) : (
						<p className="whitespace-pre-wrap break-all">
							{textContent}
						</p>
					)}
				</div>
			</div>
		);
	}

	// Find the last text segment index for streaming optimization
	const lastTextIdx = isStreaming
		? segments.reduce((acc, s, i) => (s.type === "text" ? i : acc), -1)
		: -1;

	// Assistant: free-flowing text, left-aligned, NO bubble
	return (
		<div className="py-3 space-y-2 min-w-0 overflow-hidden">
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
								className="font-bookerly flex items-start gap-2 rounded-xl px-3 py-2 text-[13px] leading-relaxed overflow-hidden"
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

					// During streaming, render the active text as plain text
					// to avoid expensive ReactMarkdown re-parses on every token.
					// Switch to full markdown once streaming ends.
					if (index === lastTextIdx) {
						return (
							<motion.div
								key={`text-${index}`}
								initial={{ opacity: 0, y: 4 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ duration: 0.2, ease: "easeOut" }}
								className="chat-prose font-bookerly text-sm whitespace-pre-wrap break-all"
								style={{ color: "var(--color-text)" }}
							>
								{segment.text}
							</motion.div>
						);
					}

				return (
			<motion.div
				key={`text-${index}`}
				initial={{ opacity: 0, y: 4 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.2, ease: "easeOut" }}
				className="chat-prose font-bookerly text-sm"
				style={{ color: "var(--color-text)" }}
			>
				<ReactMarkdown
					remarkPlugins={[remarkGfm]}
					components={mdComponents}
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
		</div>
	);
});
