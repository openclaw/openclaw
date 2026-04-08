"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { HeroSuggestions } from "./hero-suggestions";
import { ChatMessage } from "./chat-message";
import { ChatEditor, type ChatEditorHandle } from "./tiptap/chat-editor";
import { ChatVoiceInputButton } from "./chat-voice-input-button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { UnicodeSpinner } from "./unicode-spinner";
import { Dialog, DialogContent } from "./ui/dialog";
import type { ChatPanelRuntimeState } from "@/lib/chat-session-registry";
import {
	getStreamActivityLabel,
	getIncompleteAssistantReplyReason,
	hasAssistantPostToolText,
	hasAssistantText,
	hasAssistantToolActivity,
} from "./chat-stream-status";
import type { ComposioChatAction } from "@/lib/composio-chat-actions";
import type { ChatModelOption } from "@/lib/chat-models";


// ── Attachment types & helpers ──

type AttachedFile = {
	id: string;
	name: string;
	path: string;
	/** True while the file is still uploading to the server. */
	uploading?: boolean;
	/** Local blob URL for instant preview before upload completes. */
	localUrl?: string;
};

type ChatCloudState = {
	status: "no_key" | "invalid_key" | "valid";
	isDenchPrimary: boolean;
	elevenLabsEnabled: boolean;
	selectedDenchModel: string | null;
	models: ChatModelOption[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function normalizeChatModelOption(value: unknown): ChatModelOption | null {
	const record = asRecord(value);
	if (!record) {
		return null;
	}
	const stableId =
		typeof record.stableId === "string" && record.stableId.trim()
			? record.stableId.trim()
			: null;
	const displayName =
		typeof record.displayName === "string" && record.displayName.trim()
			? record.displayName.trim()
			: null;
	const provider =
		typeof record.provider === "string" && record.provider.trim()
			? record.provider.trim()
			: null;
	if (!stableId || !displayName || !provider) {
		return null;
	}
	const catalogIdRaw =
		typeof record.id === "string" && record.id.trim() ? record.id.trim() : null;
	const catalogId =
		catalogIdRaw && catalogIdRaw !== stableId ? catalogIdRaw : undefined;
	return {
		stableId,
		...(catalogId ? { catalogId } : {}),
		displayName,
		provider,
		reasoning: Boolean(record.reasoning),
	};
}

function normalizeChatCloudState(value: unknown): ChatCloudState | null {
	const record = asRecord(value);
	if (!record) {
		return null;
	}
	const models = Array.isArray(record.models)
		? record.models
				.map(normalizeChatModelOption)
				.filter((model): model is ChatModelOption => model !== null)
		: [];
	return {
		status:
			record.status === "no_key" || record.status === "invalid_key" || record.status === "valid"
				? record.status
				: "no_key",
		isDenchPrimary: Boolean(record.isDenchPrimary),
		elevenLabsEnabled: Boolean(record.elevenLabsEnabled),
		selectedDenchModel:
			typeof record.selectedDenchModel === "string" &&
			record.selectedDenchModel.trim()
				? record.selectedDenchModel.trim()
				: null,
		models,
	};
}

function getFileCategory(
	name: string,
): "image" | "video" | "audio" | "pdf" | "code" | "document" | "other" {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
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
			"js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java",
			"cpp", "c", "h", "css", "html", "json", "yaml", "yml",
			"toml", "md", "sh", "bash", "sql", "swift", "kt",
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

const categoryMeta: Record<string, { bg: string; fg: string }> = {
	image: { bg: "rgba(16, 185, 129, 0.12)", fg: "#10b981" },
	video: { bg: "rgba(139, 92, 246, 0.12)", fg: "#8b5cf6" },
	audio: { bg: "rgba(245, 158, 11, 0.12)", fg: "#f59e0b" },
	pdf: { bg: "rgba(239, 68, 68, 0.12)", fg: "#ef4444" },
	code: { bg: "rgba(59, 130, 246, 0.12)", fg: "#3b82f6" },
	document: { bg: "rgba(107, 114, 128, 0.12)", fg: "#6b7280" },
	other: { bg: "rgba(107, 114, 128, 0.08)", fg: "#9ca3af" },
};

function FileTypeIcon({ category }: { category: string }) {
	const props = {
		width: 16,
		height: 16,
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
					<rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
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

function QueueItem({
	msg,
	idx,
	onEdit,
	onSendNow,
	onRemove,
}: {
	msg: QueuedMessage;
	idx: number;
	onEdit: (id: string, text: string) => void;
	onSendNow: (id: string) => void;
	onRemove: (id: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(msg.text);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	const autoResize = () => {
		const el = inputRef.current;
		if (!el) {return;}
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	};

	useEffect(() => {
		if (editing) {
			inputRef.current?.focus();
			const len = inputRef.current?.value.length ?? 0;
			inputRef.current?.setSelectionRange(len, len);
			autoResize();
		}
	}, [editing]);

	const commitEdit = () => {
		const trimmed = draft.trim();
		if (trimmed && trimmed !== msg.text) {
			onEdit(msg.id, trimmed);
		} else {
			setDraft(msg.text);
		}
		setEditing(false);
	};

	return (
		<div
			className={`flex items-start gap-2.5 group py-2 ${idx > 0 ? "border-t" : ""}`}
			style={idx > 0 ? { borderColor: "var(--color-border)" } : undefined}
		>
			<span
				className="shrink-0 mt-px text-[11px] font-medium tabular-nums w-4"
				style={{ color: "var(--color-text-muted)" }}
			>
				{idx + 1}
			</span>
			{editing ? (
				<textarea
					ref={inputRef}
					className="flex-1 text-[13px] leading-[1.45] min-w-0 resize-none rounded-md px-2 py-1 outline-none"
					style={{
						color: "var(--color-text-secondary)",
						background: "var(--color-bg)",
						border: "1px solid var(--color-border)",
					}}
					rows={1}
					value={draft}
					onChange={(e) => { setDraft(e.target.value); autoResize(); }}
					onBlur={commitEdit}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEdit(); }
						if (e.key === "Escape") { setDraft(msg.text); setEditing(false); }
					}}
				/>
			) : (
				<div className="flex-1 min-w-0 flex items-center gap-2">
					{msg.attachedFiles.length > 0 && (
						<div className="flex gap-1 shrink-0">
							{msg.attachedFiles.map((af) => {
								const cat = getFileCategory(af.name);
								const src = cat === "image"
									? (af.localUrl || `/api/workspace/raw-file?path=${encodeURIComponent(af.path)}`)
									: af.path ? `/api/workspace/thumbnail?path=${encodeURIComponent(af.path)}&size=100` : undefined;
								return (
									<img
										key={af.id}
										src={src}
										alt={af.name}
										className="rounded object-cover"
										style={{ height: 28, width: 28, background: "var(--color-surface-hover)" }}
										onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
									/>
								);
							})}
						</div>
					)}
					<p
						className="text-[13px] leading-[1.45] line-clamp-1 min-w-0"
						style={{ color: "var(--color-text-secondary)" }}
					>
						{msg.text || `${msg.attachedFiles.length} ${msg.attachedFiles.length === 1 ? "file" : "files"}`}
					</p>
				</div>
			)}
			{!editing && (
			<div className="flex items-center gap-1 shrink-0 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
				{/* Edit */}
				<button
					type="button"
					className="rounded-md p-1 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800"
					title="Edit message"
					onClick={() => { setDraft(msg.text); setEditing(true); }}
				>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-stone-400">
							<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
							<path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
						</svg>
					</button>
					{/* Send now */}
					<button
						type="button"
						className="rounded-md p-1 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800"
						title="Send now"
						onClick={() => onSendNow(msg.id)}
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-stone-400">
							<path d="M12 19V5" />
							<path d="m5 12 7-7 7 7" />
						</svg>
					</button>
					{/* Delete */}
					<button
						type="button"
						className="rounded-md p-1 transition-colors hover:bg-stone-100 dark:hover:bg-stone-800"
						title="Remove from queue"
						onClick={() => onRemove(msg.id)}
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-stone-400">
							<path d="M3 6h18" />
							<path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
							<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
						</svg>
					</button>
				</div>
			)}
		</div>
	);
}

function AttachmentStrip({
	files,
	compact,
	onRemove,
	onClearAll: _onClearAll,
}: {
	files: AttachedFile[];
	compact?: boolean;
	onRemove: (id: string) => void;
	onClearAll: () => void;
}) {
	const [previewSrc, setPreviewSrc] = useState<string | null>(null);

	if (files.length === 0) {return null;}

	return (
		<div className={`${compact ? "px-2" : "px-3"} pt-2`}>
			<div
				className="flex gap-2 overflow-x-auto pb-1"
				style={{ scrollbarWidth: "thin" }}
			>
				{files.map((af) => {
					const category = getFileCategory(
						af.name,
					);
					const meta =
						categoryMeta[category] ??
						categoryMeta.other;
					const short = shortenPath(af.path);

					return (
						<div
							key={af.id}
							className="relative group flex-shrink-0 rounded-xl overflow-hidden"
							style={{
								background:
									"var(--color-surface-hover)",
								border: "1px solid var(--color-border)",
							}}
						>
							{/* Remove button */}
							<button
								type="button"
								onClick={() =>
									onRemove(af.id)
								}
								className="absolute top-1 right-1 z-10 w-[18px] h-[18px] rounded-full flex items-center justify-center md:opacity-0 md:group-hover:opacity-100 transition-opacity"
								style={{
									background:
										"rgba(0,0,0,0.55)",
									color: "white",
									backdropFilter:
										"blur(4px)",
								}}
							>
								<svg
									width="8"
									height="8"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="3"
									strokeLinecap="round"
								>
									<path d="M18 6 6 18" />
									<path d="m6 6 12 12" />
								</svg>
							</button>

							{category === "image" ? (
								<img
									src={af.localUrl || `/api/workspace/raw-file?path=${encodeURIComponent(af.path)}`}
									alt={af.name}
									className="block rounded-xl object-cover cursor-pointer transition-all duration-200 hover:opacity-95"
									style={{
										height: 80,
										width: "auto",
										minWidth: 60,
										maxWidth: 140,
										opacity: af.uploading ? 0.6 : 1,
										background: "var(--color-bg-secondary)",
									}}
									onClick={() => {
										const src = af.localUrl || `/api/workspace/raw-file?path=${encodeURIComponent(af.path)}`;
										setPreviewSrc(src);
									}}
									onError={(e) => {
										(e.currentTarget as HTMLImageElement).style.display = "none";
									}}
								/>
							) : category === "pdf" && af.path ? (
								/* PDF thumbnail via Quick Look */
								<img
									src={`/api/workspace/thumbnail?path=${encodeURIComponent(af.path)}&size=200`}
									alt={af.name}
									className="block rounded-xl object-cover"
									style={{
										height: 80,
										width: "auto",
										minWidth: 60,
										maxWidth: 140,
										opacity: af.uploading ? 0.6 : 1,
										background: "var(--color-bg-secondary)",
									}}
									onError={(e) => {
										(e.currentTarget as HTMLImageElement).style.display = "none";
									}}
								/>
							) : (
								<div className="flex items-center gap-2.5 px-3 py-2.5" style={{ opacity: af.uploading ? 0.6 : 1 }}>
									<div
										className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
										style={{
											background: meta.bg,
											color: meta.fg,
										}}
									>
										<FileTypeIcon category={category} />
									</div>
									<div className="min-w-0 max-w-[140px]">
										<p
											className="text-[11px] font-medium truncate"
											style={{ color: "var(--color-text)" }}
											title={af.path || af.name}
										>
											{af.name}
										</p>
										<p
											className="text-[9px] truncate"
											style={{ color: "var(--color-text-muted)" }}
											title={af.path || af.name}
										>
											{af.uploading ? "Uploading..." : short}
										</p>
									</div>
								</div>
							)}
						</div>
					);
				})}
			</div>

			<Dialog open={previewSrc !== null} onOpenChange={(open) => { if (!open) {setPreviewSrc(null);} }}>
				<DialogContent className="!max-w-[90vw] !w-auto !p-0 !rounded-2xl !bg-transparent !border-none !shadow-[0_0_120px_rgba(0,0,0,0.4)]" showCloseButton={false}>
					<button
						type="button"
						onClick={() => setPreviewSrc(null)}
						className="absolute top-3 right-3 z-10 w-7 h-7 rounded-full flex items-center justify-center cursor-pointer outline-none transition-all hover:opacity-85"
						style={{ background: "rgba(0,0,0,0.55)", color: "white", backdropFilter: "blur(4px)", boxShadow: "0 2px 8px rgba(0,0,0,0.3)" }}
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
					</button>
					{previewSrc && (
						<img
							src={previewSrc}
							alt="Preview"
							className="block rounded-xl"
							style={{ maxHeight: "80vh", maxWidth: "85vw", objectFit: "contain" }}
						/>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}

// ── SSE stream parser for reconnection ──
// Converts raw SSE events (AI SDK v6 wire format) into UIMessage parts.

type ParsedPart =
	| { type: "text"; text: string }
	| { type: "user-message"; id?: string; text: string }
	| { type: "reasoning"; text: string; state?: string }
	| {
			type: "dynamic-tool";
			toolName: string;
			toolCallId: string;
			state: string;
			input?: Record<string, unknown>;
			output?: Record<string, unknown>;
			preliminary?: boolean;
		};

export function createStreamParser() {
	const parts: ParsedPart[] = [];
	let currentTextIdx = -1;
	let currentReasoningIdx = -1;

	function processEvent(event: Record<string, unknown>) {
		const t = event.type as string;

		switch (t) {
			case "user-message":
				currentTextIdx = -1;
				currentReasoningIdx = -1;
				parts.push({
					type: "user-message",
					id: event.id as string | undefined,
					text: (event.text as string) ?? "",
				});
				break;
			case "reasoning-start":
				parts.push({
					type: "reasoning",
					text: "",
					state: "streaming",
				});
				currentReasoningIdx = parts.length - 1;
				break;
			case "reasoning-delta": {
				if (currentReasoningIdx >= 0) {
					const p = parts[currentReasoningIdx] as {
						type: "reasoning";
						text: string;
					};
					p.text += event.delta as string;
				}
				break;
			}
			case "reasoning-end":
				if (currentReasoningIdx >= 0) {
					const p = parts[currentReasoningIdx] as {
						type: "reasoning";
						state?: string;
					};
					delete p.state;
				}
				currentReasoningIdx = -1;
				break;
			case "text-start":
				parts.push({ type: "text", text: "" });
				currentTextIdx = parts.length - 1;
				break;
			case "text-delta": {
				if (currentTextIdx >= 0) {
					const p = parts[currentTextIdx] as {
						type: "text";
						text: string;
					};
					p.text += event.delta as string;
				}
				break;
			}
			case "text-end":
				currentTextIdx = -1;
				break;
			case "tool-input-start":
				for (let i = parts.length - 1; i >= 0; i--) {
					const p = parts[i];
					if (
						p.type === "dynamic-tool" &&
						p.toolCallId === event.toolCallId
					) {
						p.toolName = event.toolName as string;
						p.state = "input-available";
						if (!p.input) {
							p.input = {};
						}
						return;
					}
				}
				parts.push({
					type: "dynamic-tool",
					toolCallId: event.toolCallId as string,
					toolName: event.toolName as string,
					state: "input-available",
					input: {},
				});
				break;
			case "tool-input-available":
				for (let i = parts.length - 1; i >= 0; i--) {
					const p = parts[i];
					if (
						p.type === "dynamic-tool" &&
						p.toolCallId === event.toolCallId
					) {
						p.input =
							(event.input as Record<string, unknown>) ??
							{};
						break;
					}
				}
				break;
			case "tool-output-partial":
				for (let i = parts.length - 1; i >= 0; i--) {
					const p = parts[i];
					if (
						p.type === "dynamic-tool" &&
						p.toolCallId === event.toolCallId
					) {
						p.preliminary = true;
						p.output =
							(event.output as Record<
								string,
								unknown
							>) ?? {};
						break;
					}
				}
				break;
			case "tool-output-available":
				for (let i = parts.length - 1; i >= 0; i--) {
					const p = parts[i];
					if (
						p.type === "dynamic-tool" &&
						p.toolCallId === event.toolCallId
					) {
						if (event.preliminary === true) {
							p.preliminary = true;
							p.state = "input-available";
						} else {
							delete p.preliminary;
							p.state = "output-available";
						}
						p.output =
							(event.output as Record<
								string,
								unknown
							>) ?? {};
						break;
					}
				}
				break;
			case "tool-output-error":
				for (let i = parts.length - 1; i >= 0; i--) {
					const p = parts[i];
					if (
						p.type === "dynamic-tool" &&
						p.toolCallId === event.toolCallId
					) {
						p.state = "error";
						p.output = {
							error: event.errorText as string,
						};
						break;
					}
				}
				break;
		}
	}

	return {
		processEvent,
		getParts: (): ParsedPart[] => parts.map((p) => ({ ...p })),
	};
}

/** Imperative handle for parent-driven session control (main page). */
export type ChatPanelHandle = {
	loadSession: (sessionId: string) => Promise<void>;
	newSession: () => Promise<void>;
	/** Create a new session and immediately send a message. */
	sendNewMessage: (text: string) => Promise<void>;
	/** Insert a file mention into the chat editor (e.g. from sidebar drag). */
	insertFileMention?: (name: string, path: string) => void;
};

export type FileContext = {
	path: string;
	filename: string;
	/** When true the path refers to a directory rather than a file. */
	isDirectory?: boolean;
};

type FileScopedSession = {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
};

/** A message waiting to be sent after the current agent run finishes. */
type QueuedMessage = {
	id: string;
	text: string;
	html: string;
	mentionedFiles: Array<{ name: string; path: string }>;
	attachedFiles: AttachedFile[];
	createdAt: number;
};

export type SubagentSpawnInfo = {
	childSessionKey: string;
	runId: string;
	task: string;
	label?: string;
	parentSessionId: string;
	status?: "running" | "completed" | "error";
};

type ChatPanelProps = {
	/** When set, scopes sessions to this file and prepends content as context. */
	fileContext?: FileContext;
	/** Compact mode for workspace sidebar (smaller UI, built-in session tabs). */
	compact?: boolean;
	/** Override the header title when a session is active (e.g. show the session's actual title). */
	sessionTitle?: string;
	/** Session ID to auto-load on mount (for non-file panels that remount after navigation). */
	initialSessionId?: string;
	/** Called when file content may have changed after agent edits. */
	onFileChanged?: (newContent: string) => void;
	/** Called when active session changes (for external sidebar highlighting). */
	onActiveSessionChange?: (sessionId: string | null) => void;
	/** Called when session list needs refresh (for external sidebar). */
	onSessionsChange?: () => void;
	/** Called when the agent spawns a subagent. */
	onSubagentSpawned?: (info: SubagentSpawnInfo) => void;
	/** Called when user clicks a subagent card in the chat to view its output. */
	onSubagentClick?: (task: string) => void;
	/** Called when user clicks an inline file path in chat output. */
	onFilePathClick?: (path: string) => Promise<boolean | void> | boolean | void;
	/** Called when the assistant emits a Composio connect/reconnect action link. */
	onComposioAction?: (action: ComposioChatAction) => void;
	/** Called when user deletes the current session (e.g. from header menu). */
	onDeleteSession?: (sessionId: string) => void;
	/** Called when user renames the current session. */
	onRenameSession?: (sessionId: string, newTitle: string) => void;
	/** Subagent mode: when set, connects to an existing subagent session via its gateway session key. */
	sessionKey?: string;
	/** The subagent task description (shown as the first user message in subagent mode). */
	subagentTask?: string;
	/** Display label for the subagent header. */
	subagentLabel?: string;
	/** Back button handler (subagent mode only). */
	onBack?: () => void;
	/** Hide the header action buttons (when they're rendered elsewhere, e.g. tab bar). */
	hideHeaderActions?: boolean;
	/** Called whenever the panel's runtime state changes. */
	onRuntimeStateChange?: (state: ChatPanelRuntimeState) => void;
	/** Called when the conversation advances and the hosting tab should persist. */
	onConversationActivity?: () => void;
	/** Gateway session key for channel sessions (telegram, discord, etc.). */
	gatewaySessionKey?: string;
	/** Gateway session UUID for loading transcripts. */
	gatewaySessionId?: string;
	/** Channel identifier for the gateway session (e.g. "telegram"). */
	gatewayChannel?: string;
	/** Whether this panel's tab is currently visible/active. Used to focus the editor on tab switch. */
	visible?: boolean;
};

export const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(
	function ChatPanelInner(
		{
			fileContext,
			compact,
			sessionTitle,
			initialSessionId,
			onFileChanged,
			onActiveSessionChange,
			onSessionsChange,
			onSubagentSpawned,
			onSubagentClick,
			onFilePathClick,
			onComposioAction,
			onDeleteSession,
			onRenameSession: _onRenameSession,
			sessionKey: subagentSessionKey,
			subagentTask,
			subagentLabel,
			onBack,
			hideHeaderActions,
			onRuntimeStateChange,
			onConversationActivity,
			gatewaySessionKey,
			gatewaySessionId,
			gatewayChannel: _gatewayChannel,
			visible,
		},
		ref,
	) {
		const isSubagentMode = !!subagentSessionKey;
		const isGatewayMode = !!gatewaySessionKey;
		const editorRef = useRef<ChatEditorHandle>(null);
		const [editorEmpty, setEditorEmpty] = useState(true);
		const [currentSessionId, setCurrentSessionId] = useState<
			string | null
		>(null);
		const [loadingSession, setLoadingSession] = useState(false);
		const messagesEndRef = useRef<HTMLDivElement>(null);

		// ── Attachment state ──
		const [attachedFiles, setAttachedFiles] = useState<
			AttachedFile[]
		>([]);
		const fileInputRef = useRef<HTMLInputElement>(null);

		const [mounted, setMounted] = useState(false);
		useEffect(() => { setMounted(true); }, []);

		useEffect(() => {
			if (visible === false) return;
			const timer = setTimeout(() => {
				editorRef.current?.focus();
			}, 150);
			return () => clearTimeout(timer);
		}, [visible]);

		// ── Reconnection state ──
		const [isReconnecting, setIsReconnecting] = useState(false);
		const reconnectAbortRef = useRef<AbortController | null>(null);

		// ── Stream-level error (empty response detection) ──
		const [streamError, setStreamError] = useState<string | null>(null);

		// Track persisted messages to avoid double-saves
		const savedMessageIdsRef = useRef<Set<string>>(new Set());
		// Set when /new or + triggers a new session
		const newSessionPendingRef = useRef(false);
		// Whether the next message should include file context
		const isFirstFileMessageRef = useRef(true);

		// File-scoped session list (compact mode only)
		const [fileSessions, setFileSessions] = useState<
			FileScopedSession[]
		>([]);

		// ── Rich HTML for user messages (keyed by message ID or text fallback) ──
		const userHtmlMapRef = useRef(new Map<string, string>());
		const pendingHtmlRef = useRef<string | null>(null);

		// ── Message queue (messages to send after current run completes) ──
		const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
		const [rawView, _setRawView] = useState(false);
		const [cloudState, setCloudState] = useState<ChatCloudState | null>(null);
		// ── Hero state (new chat screen) ──
		const greeting = "What can I help with?";

		const handlePromptClick = useCallback((prompt: string) => {
			editorRef.current?.setText(prompt);
			setEditorEmpty(false);
		}, []);

		const handleVoiceTranscript = useCallback((text: string) => {
			editorRef.current?.appendText(text);
			setEditorEmpty(false);
		}, []);

		const filePath = fileContext?.path ?? null;

		// ── Ref-based session ID for transport ──
		const sessionIdRef = useRef<string | null>(null);
		useEffect(() => {
			sessionIdRef.current = currentSessionId;
		}, [currentSessionId]);

		const subagentSessionKeyRef = useRef(subagentSessionKey);
		useEffect(() => {
			subagentSessionKeyRef.current = subagentSessionKey;
		}, [subagentSessionKey]);

		// ── Transport (per-instance) ──
		const transport = useMemo(
			() =>
				new DefaultChatTransport({
					api: "/api/chat",
					body: () => {
						const extra: Record<string, unknown> = {};
						const sk = subagentSessionKeyRef.current;
						if (sk) {extra.sessionKey = sk;}
						const sid = sessionIdRef.current;
						if (sid) {extra.sessionId = sid;}
						if (pendingHtmlRef.current) {
							extra.userHtml = pendingHtmlRef.current;
							pendingHtmlRef.current = null;
						}
						return extra;
					},
				}),
			[],
		);

		const { messages, sendMessage, status, stop, error, setMessages } =
			useChat({ transport });

		const isStreaming =
			status === "streaming" ||
			status === "submitted" ||
			isReconnecting;

		// Keep cloud catalog + primary model in sync (hero, session switches, and after
		// completed turns — agent tools may change agents.defaults.model.primary).
		useEffect(() => {
			if (status !== "ready") {
				return;
			}
			let cancelled = false;
			const controller = new AbortController();
			void (async () => {
				try {
					const res = await fetch("/api/settings/cloud", {
						cache: "no-store",
						signal: controller.signal,
					});
					if (!res.ok) {
						return;
					}
					const raw = await res.json();
					const next = normalizeChatCloudState(raw);
					if (!cancelled && next) {
						setCloudState(next);
					}
				} catch {
					// Best-effort only; the chat should work even if cloud state is unavailable.
				}
			})();
			return () => {
				cancelled = true;
				controller.abort();
			};
		}, [status, messages.length, currentSessionId]);

		const preferServerVoiceInput = Boolean(
			cloudState?.status === "valid" && cloudState.elevenLabsEnabled,
		);
		const voicePlaybackEnabled = Boolean(
			cloudState?.status === "valid" && cloudState.elevenLabsEnabled,
		);

		const onRuntimeStateChangeRef = useRef(onRuntimeStateChange);
		onRuntimeStateChangeRef.current = onRuntimeStateChange;

		useEffect(() => {
			onRuntimeStateChangeRef.current?.({
				sessionId: currentSessionId,
				sessionKey: subagentSessionKey ?? null,
				isStreaming,
				status,
				isReconnecting,
				loadingSession,
			});
		}, [
			currentSessionId,
			subagentSessionKey,
			isStreaming,
			status,
			isReconnecting,
			loadingSession,
		]);

		// Stream stall detection: if we stay in "submitted" (no first
		// token received) for too long, surface an error and reset.
		const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		useEffect(() => {
			if (stallTimerRef.current) {
				clearTimeout(stallTimerRef.current);
				stallTimerRef.current = null;
			}
			if (status === "submitted") {
				stallTimerRef.current = setTimeout(() => {
					stallTimerRef.current = null;
					if (status === "submitted") {
						setStreamError("Request timed out — no response from agent. Try again or check the gateway.");
						void stop();
					}
				}, 90_000);
			}
			return () => {
				if (stallTimerRef.current) {
					clearTimeout(stallTimerRef.current);
					stallTimerRef.current = null;
				}
			};
		}, [status, stop]);

		// Auto-scroll to bottom on new messages, but only when the user
		// is already near the bottom.  If the user scrolls up during
		// streaming, we stop auto-scrolling until they return to the
		// bottom (or a new user message is sent).
		const scrollContainerRef = useRef<HTMLDivElement>(null);
		const userScrolledAwayRef = useRef(false);
		const scrollRafRef = useRef(0);
		const [showScrollButton, setShowScrollButton] = useState(false);

		// Detect when the user scrolls away from the bottom.
		useEffect(() => {
			const el = scrollContainerRef.current;
			if (!el) {return;}

			const onScroll = () => {
				const distanceFromBottom =
					el.scrollHeight - el.scrollTop - el.clientHeight;
				const away = distanceFromBottom > 80;
				userScrolledAwayRef.current = away;
				setShowScrollButton(away);
			};

			el.addEventListener("scroll", onScroll, { passive: true });
			return () => el.removeEventListener("scroll", onScroll);
		}, []);

		const scrollToBottom = useCallback(() => {
			messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
		}, []);

		// Auto-scroll effect — skips when user has scrolled away.
		useEffect(() => {
			if (userScrolledAwayRef.current) {return;}
			if (scrollRafRef.current) {return;}
			scrollRafRef.current = requestAnimationFrame(() => {
				scrollRafRef.current = 0;
				messagesEndRef.current?.scrollIntoView({
					behavior: "smooth",
				});
			});
		}, [messages]);

		// ── Session persistence helpers ──

		const createSession = useCallback(
			async (title: string): Promise<string> => {
				const body: Record<string, string> = { title };
				if (filePath) {
					body.filePath = filePath;
				}
				const res = await fetch("/api/web-sessions", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				const data = await res.json();
				return data.session.id;
			},
			[filePath],
		);

		// ── Stream reconnection ──
		// Attempts to reconnect to an active agent run for the given session.
		// Replays buffered SSE events and streams live updates.
		// Accepts either a web sessionId or a gateway sessionKey (subagent mode).
		const attemptReconnect = useCallback(
			async (
				sessionId: string,
				baseMessages: Array<{
					id: string;
					role: "user" | "assistant" | "system";
					parts: UIMessage["parts"];
				}>,
				options?: { sessionKey?: string },
			): Promise<boolean> => {
				const abort = new AbortController();
				reconnectAbortRef.current = abort;

				try {
					const sk = options?.sessionKey;
					const isGwSession = sk && !sk.includes(":subagent:") && !sk.includes(":web:");
					const streamUrl = isGwSession
						? `/api/gateway/chat/stream?sessionKey=${encodeURIComponent(sk)}`
						: sk
							? `/api/chat/stream?sessionKey=${encodeURIComponent(sk)}`
							: `/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}`;
					const res = await fetch(
						streamUrl,
						{ signal: abort.signal },
					);
					if (!res.ok || !res.body) {
						return false; // No active run
					}

					// If the run already completed (still in the grace
					// period), skip the SSE replay -- the persisted
					// messages we already loaded are final.
					if (res.headers.get("X-Run-Active") === "false") {
						void res.body.cancel();
						return false;
					}

					setIsReconnecting(true);

					const parser = createStreamParser();
					const reader = res.body.getReader();
					const decoder = new TextDecoder();
					const reconnectMsgId = `reconnect-${sessionId}`;
					let buffer = "";
					let frameRequested = false;

					const updateUI = () => {
						// Guard: if the session was switched while a
						// rAF was pending, don't overwrite the new
						// session's messages with stale data.
						if (abort.signal.aborted) {return;}
						const assistantMsg = {
							id: reconnectMsgId,
							role: "assistant" as const,
							parts: parser.getParts() as UIMessage["parts"],
						};
						setMessages([
							...baseMessages,
							assistantMsg,
						]);
					};

					// Read the SSE stream
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- loop reads until done
					while (true) {
						const { done, value } =
							await reader.read();
						if (done) {break;}

						buffer += decoder.decode(value, {
							stream: true,
						});

						// Parse SSE events (data: <json>\n\n)
						let idx;
						while (
							(idx = buffer.indexOf("\n\n")) !== -1
						) {
							const chunk = buffer.slice(0, idx);
							buffer = buffer.slice(idx + 2);

							if (chunk.startsWith("data: ")) {
								try {
									const event = JSON.parse(
										chunk.slice(6),
									);
									parser.processEvent(event);
								} catch {
									/* skip malformed events */
								}
							}
						}

						// Batch UI updates to animation frames
						if (!frameRequested) {
							frameRequested = true;
							requestAnimationFrame(() => {
								frameRequested = false;
								updateUI();
							});
						}
					}

					// Final update after stream ends
					updateUI();

					// Mark all messages as saved (server persisted them)
					if (!abort.signal.aborted) {
						for (const m of baseMessages) {
							savedMessageIdsRef.current.add(m.id);
						}
						savedMessageIdsRef.current.add(reconnectMsgId);
					}

					setIsReconnecting(false);
					reconnectAbortRef.current = null;
					return true;
				} catch (err) {
					if (
						(err as Error).name !== "AbortError"
					) {
						console.error(
							"Reconnection error:",
							err,
						);
					}
					setIsReconnecting(false);
					reconnectAbortRef.current = null;
					return false;
				}
			},
			[setMessages],
		);

		// ── File-scoped session initialization ──
		const fetchFileSessionsRef = useRef<
			(() => Promise<FileScopedSession[]>) | null
		>(null);

		fetchFileSessionsRef.current = async () => {
			if (!filePath) {
				return [];
			}
			try {
				const res = await fetch(
					`/api/web-sessions?filePath=${encodeURIComponent(filePath)}`,
				);
				const data = await res.json();
				return (data.sessions || []) as FileScopedSession[];
			} catch {
				return [];
			}
		};

		useEffect(() => {
			if (!filePath || isSubagentMode) {
				return;
			}
			let cancelled = false;

			sessionIdRef.current = null;
			setCurrentSessionId(null);
			onActiveSessionChange?.(null);
			setMessages([]);
			savedMessageIdsRef.current.clear();
			isFirstFileMessageRef.current = true;

			void (async () => {
				const sessions =
					(await fetchFileSessionsRef.current?.()) ?? [];
				if (cancelled) {
					return;
				}
				setFileSessions(sessions);

				if (sessions.length > 0) {
					const target = (initialSessionId
						? sessions.find((s) => s.id === initialSessionId)
						: undefined) ?? sessions[0];
					setCurrentSessionId(target.id);
					sessionIdRef.current = target.id;
					onActiveSessionChange?.(target.id);
					isFirstFileMessageRef.current = false;

					try {
						const msgRes = await fetch(
							`/api/web-sessions/${target.id}`,
						);
						if (cancelled) {
							return;
						}
						const msgData = await msgRes.json();
						const sessionMessages: Array<{
							id: string;
							role: "user" | "assistant";
							content: string;
							parts?: Array<Record<string, unknown>>;
							html?: string;
							_streaming?: boolean;
						}> = msgData.messages || [];

						const hasStreaming = sessionMessages.some(
							(m) => m._streaming,
						);
						const completedMessages = hasStreaming
							? sessionMessages.filter(
									(m) => !m._streaming,
								)
							: sessionMessages;

						for (const msg of completedMessages) {
							if (msg.role === "user" && msg.html) {
								userHtmlMapRef.current.set(msg.id, msg.html);
							}
						}

						const uiMessages = completedMessages.map(
							(msg) => {
								savedMessageIdsRef.current.add(msg.id);
								return {
									id: msg.id,
									role: msg.role,
									parts: (msg.parts ?? [
										{
											type: "text" as const,
											text: msg.content,
										},
									]) as UIMessage["parts"],
								};
							},
						);
						if (!cancelled) {
							setMessages(uiMessages);
						}

						if (!cancelled) {
							await attemptReconnect(
								target.id,
								uiMessages,
							);
						}
					} catch {
						// ignore
					}
				}
			})();

			return () => {
				cancelled = true;
			};
			// eslint-disable-next-line react-hooks/exhaustive-deps -- stable setters
		}, [filePath, attemptReconnect]);

		// ── Non-file panel: auto-restore session on mount or URL change ──
		const initialSessionHandled = useRef(false);
		const lastInitialSessionRef = useRef<string | null>(null);
		useEffect(() => {
			if (filePath || isSubagentMode || isGatewayMode || !initialSessionId) {
				return;
			}
			if (initialSessionHandled.current && initialSessionId === lastInitialSessionRef.current) {
				return;
			}
			initialSessionHandled.current = true;
			lastInitialSessionRef.current = initialSessionId;
			void handleSessionSelect(initialSessionId);
			// eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-run when initialSessionId changes
		}, [initialSessionId]);

		// ── Subagent mode: load persisted messages + reconnect to active stream ──
		useEffect(() => {
			if (!subagentSessionKey || !subagentTask) {return;}
			let cancelled = false;

			reconnectAbortRef.current?.abort();
			void stop();
			savedMessageIdsRef.current.clear();
			setQueuedMessages([]);

			const taskMsg = {
				id: `task-${subagentSessionKey}`,
				role: "user" as const,
				parts: [{ type: "text" as const, text: subagentTask }] as UIMessage["parts"],
			};
			setMessages([taskMsg]);

			void (async () => {
				if (cancelled) {return;}

				// Load persisted messages from the subagent session JSONL
				let baseMessages: Array<{ id: string; role: "user" | "assistant"; parts: UIMessage["parts"] }> = [taskMsg];
				try {
					const msgRes = await fetch(`/api/web-sessions/${encodeURIComponent(subagentSessionKey)}`);
					if (cancelled) {return;}
					if (msgRes.ok) {
						const msgData = await msgRes.json();
						const sessionMessages: Array<{
							id: string;
							role: "user" | "assistant";
							content: string;
							parts?: Array<Record<string, unknown>>;
							html?: string;
							_streaming?: boolean;
						}> = msgData.messages || [];

						const completedMessages = sessionMessages.some((m) => m._streaming)
							? sessionMessages.filter((m) => !m._streaming)
							: sessionMessages;

						if (completedMessages.length > 0) {
							for (const msg of completedMessages) {
								if (msg.role === "user" && msg.html) {
									userHtmlMapRef.current.set(msg.id, msg.html);
								}
							}
							const uiMessages = completedMessages.map((msg) => {
								savedMessageIdsRef.current.add(msg.id);
								return {
									id: msg.id,
									role: msg.role,
									parts: (msg.parts ?? [{ type: "text" as const, text: msg.content }]) as UIMessage["parts"],
								};
							});
							baseMessages = [taskMsg, ...uiMessages];
							if (!cancelled) {
								setMessages(baseMessages);
							}
						}
					} else {
						// No persisted session file — use task message only
					}
				} catch {
					// ignore — fall through to reconnect with task message only
				}

				// Try to reconnect to an active stream (may be still running)
				if (!cancelled) {
					await attemptReconnect(subagentSessionKey, baseMessages, { sessionKey: subagentSessionKey });
				}
			})();

			return () => {
				cancelled = true;
				reconnectAbortRef.current?.abort();
			};
			// eslint-disable-next-line react-hooks/exhaustive-deps -- stable setters
		}, [subagentSessionKey, subagentTask, attemptReconnect]);

		// ── Gateway session mode: load transcript + reconnect to active stream ──
		useEffect(() => {
			if (!gatewaySessionKey || !gatewaySessionId) return;
			let cancelled = false;

			reconnectAbortRef.current?.abort();
			void stop();
			savedMessageIdsRef.current.clear();
			setQueuedMessages([]);
			setLoadingSession(true);

			void (async () => {
				let baseMessages: Array<{ id: string; role: "user" | "assistant"; parts: UIMessage["parts"] }> = [];
				try {
					const res = await fetch(`/api/gateway/sessions/${encodeURIComponent(gatewaySessionId)}`);
					if (cancelled) return;
					if (res.ok) {
						const data = await res.json();
						const sessionMessages: Array<{
							id: string;
							role: "user" | "assistant";
							content: string;
							parts?: Array<Record<string, unknown>>;
						}> = data.messages || [];

						const uiMessages = sessionMessages.map((msg) => {
							savedMessageIdsRef.current.add(msg.id);
							return {
								id: msg.id,
								role: msg.role,
								parts: (msg.parts ?? [{ type: "text" as const, text: msg.content }]) as UIMessage["parts"],
							};
						});
						baseMessages = uiMessages;
						if (!cancelled) setMessages(baseMessages);
					}
				} catch { /* ignore */ }

				if (!cancelled) {
					setLoadingSession(false);
					await attemptReconnect(gatewaySessionKey, baseMessages, { sessionKey: gatewaySessionKey });
				}
			})();

			return () => {
				cancelled = true;
				reconnectAbortRef.current?.abort();
			};
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [gatewaySessionKey, gatewaySessionId, attemptReconnect]);

		// ── Poll for subagent spawns during active streaming ──
		const [hasRunningSubagents, setHasRunningSubagents] = useState(false);

		useEffect(() => {
			if (!currentSessionId || !onSubagentSpawned) {return;}
			let cancelled = false;

			const poll = async () => {
				try {
					const res = await fetch(
						`/api/chat/subagents?sessionId=${encodeURIComponent(currentSessionId)}`,
					);
					if (cancelled || !res.ok) {return;}
					const data = await res.json();
					const subagents: Array<{
						sessionKey: string;
						runId: string;
						task: string;
						label?: string;
						status: "running" | "completed" | "error";
					}> = data.subagents ?? [];
					let anyRunning = false;
					for (const sa of subagents) {
						if (sa.status === "running") {anyRunning = true;}
						onSubagentSpawned({
							childSessionKey: sa.sessionKey,
							runId: sa.runId,
							task: sa.task,
							label: sa.label,
							parentSessionId: currentSessionId,
							status: sa.status,
						});
					}
					if (!cancelled) {setHasRunningSubagents(anyRunning);}
				} catch { /* ignore */ }
			};

			void poll();
			const id = setInterval(poll, 3_000);
			return () => { cancelled = true; clearInterval(id); };
		}, [currentSessionId, onSubagentSpawned]);

		// ── Post-stream side-effects (file-reload, session refresh) ──
		// Message persistence is handled server-side by ActiveRunManager,
		// so we only refresh the file sessions list and notify the parent
		// when the file content may have changed.
		const prevStatusRef = useRef(status);
		const previousStatus = prevStatusRef.current;
		useEffect(() => {
			const wasStreaming =
				previousStatus === "streaming" ||
				previousStatus === "submitted";
			const isNowReady = status === "ready";

			if (wasStreaming && isNowReady && currentSessionId) {
				// Mark all current messages as saved — the server
				// already persisted them via ActiveRunManager.
				for (const m of messages) {
					savedMessageIdsRef.current.add(m.id);
				}

			if (filePath) {
				void fetchFileSessionsRef.current?.().then(
					(sessions) => {
						setFileSessions(sessions);
					},
				);
			}

			if (filePath && onFileChanged) {
					fetch(
						`/api/workspace/file?path=${encodeURIComponent(filePath)}`,
					)
						.then((r) => r.json())
						.then((data) => {
							if (data.content) {
								onFileChanged(data.content);
							}
						})
						.catch(() => {});
				}

				onSessionsChange?.();
			}
		}, [
			previousStatus,
			status,
			messages,
			currentSessionId,
			filePath,
			onFileChanged,
			onSessionsChange,
		]);

		// ── Empty-stream error detection ──
		// When the stream completes (submitted/streaming → ready) but no
		// assistant message was produced, surface an error so the user knows
		// the request was lost.  We defer the check by one tick so the
		// `messages` state from `useChat` can settle — status can transition
		// to "ready" before the final message batch is committed to state.
		const emptyStreamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		useEffect(() => {
			if (emptyStreamTimerRef.current) {
				clearTimeout(emptyStreamTimerRef.current);
				emptyStreamTimerRef.current = null;
			}

			const wasActive =
				previousStatus === "streaming" ||
				previousStatus === "submitted";
			const isNowReady = status === "ready";

			if (wasActive && isNowReady) {
				emptyStreamTimerRef.current = setTimeout(() => {
					emptyStreamTimerRef.current = null;
					const lastMsg = messages[messages.length - 1];
					const hasToolOnlyActivity = hasAssistantToolActivity(lastMsg ?? null);
					const hasVisibleReply = hasToolOnlyActivity
						? hasAssistantPostToolText(lastMsg ?? null)
						: hasAssistantText(lastMsg ?? null);
					const incompleteReplyReason = getIncompleteAssistantReplyReason(lastMsg ?? null);
					if (!hasVisibleReply && !hasToolOnlyActivity && !error) {
						setStreamError("No response received from agent.");
					} else if (!hasVisibleReply && hasToolOnlyActivity && !error) {
						setStreamError(
							incompleteReplyReason ?? "Agent finished tool activity but did not send a final text reply.",
						);
					} else {
						setStreamError(null);
					}
				}, 50);
			}
			if (status === "submitted") {
				setStreamError(null);
			}
			return () => {
				if (emptyStreamTimerRef.current) {
					clearTimeout(emptyStreamTimerRef.current);
					emptyStreamTimerRef.current = null;
				}
			};
		}, [previousStatus, status, messages, error]);

		useEffect(() => {
			prevStatusRef.current = status;
		}, [status]);

		// ── Actions ──

		// Ref for handleNewSession so handleEditorSubmit doesn't depend on the hook order
		const handleNewSessionRef = useRef<() => void>(() => {});

		/** Submit from the Tiptap editor (called on Enter or send button).
		 *  `overrideAttachments` is used by the queue system to pass saved attachments directly. */
		const handleEditorSubmit = useCallback(
			async (
				text: string,
				mentionedFiles: Array<{ name: string; path: string }>,
				html: string,
				overrideAttachments?: AttachedFile[],
			) => {
				const hasText = text.trim().length > 0;
				const hasMentions = mentionedFiles.length > 0;
				// Use override attachments (from queue) or current state
				const readyFiles = overrideAttachments
					? overrideAttachments.filter((f) => !f.uploading && f.path)
					: attachedFiles.filter((f) => !f.uploading && f.path);
				const hasFiles = readyFiles.length > 0;
				if (!hasText && !hasMentions && !hasFiles) {
					return;
				}

				const userText = text.trim();
				const currentAttachments = [...readyFiles];

				if (userText.toLowerCase() === "/new") {
					// Revoke blob URLs before clearing
					for (const f of attachedFiles) {
						if (f.localUrl) {URL.revokeObjectURL(f.localUrl);}
					}
					setAttachedFiles([]);
					handleNewSessionRef.current();
					return;
				}

				onConversationActivity?.();

				// Queue the message if the agent is still running.
				if (isStreaming) {
					if (!overrideAttachments) {
						setAttachedFiles([]);
					}
					setQueuedMessages((prev) => [
						...prev,
						{
							id: crypto.randomUUID(),
							text: userText,
							html,
							mentionedFiles,
							attachedFiles: currentAttachments,
							createdAt: Date.now(),
						},
					]);
					return;
				}

				// Clear attachments (revoke blob URLs to free memory)
				if (!overrideAttachments && currentAttachments.length > 0) {
					for (const f of attachedFiles) {
						if (f.localUrl) {URL.revokeObjectURL(f.localUrl);}
					}
					setAttachedFiles([]);
				}

				let sessionId = currentSessionId;
				if (!sessionId && !isSubagentMode && !isGatewayMode) {
					const titleSource =
						userText || "File attachment";
					const title =
						titleSource.length > 60
							? titleSource.slice(0, 60) + "..."
							: titleSource;
					sessionId = await createSession(title);
					setCurrentSessionId(sessionId);
					sessionIdRef.current = sessionId;
					onActiveSessionChange?.(sessionId);
					onSessionsChange?.();

					if (filePath) {
						void fetchFileSessionsRef.current?.().then(
							(sessions) => {
								setFileSessions(sessions);
							},
						);
					}
				}

				// Build message with optional attachment prefix
				let messageText = userText;

				// Merge mention paths and attachment paths
				const allFilePaths = [
					...mentionedFiles.map((f) => f.path),
					...currentAttachments.map((f) => f.path),
				];
				if (allFilePaths.length > 0) {
					const prefix = `[Attached files: ${allFilePaths.join(", ")}]`;
					messageText = messageText
						? `${prefix}\n\n${messageText}`
						: prefix;
				}

				if (fileContext && isFirstFileMessageRef.current) {
					const label = fileContext.isDirectory ? "directory" : "file";
					messageText = `[Context: workspace ${label} '${fileContext.path}']\n\n${messageText}`;
					isFirstFileMessageRef.current = false;
				}

				// Store HTML for display and pipe to server via transport
				userHtmlMapRef.current.set(messageText, html);
				pendingHtmlRef.current = html;

				userScrolledAwayRef.current = false;

				if (gatewaySessionKey) {
					const userMsg = {
						id: `user-${Date.now()}`,
						role: "user" as const,
						parts: [{ type: "text" as const, text: messageText }] as UIMessage["parts"],
					};
					setMessages((prev) => [...prev, userMsg]);

					try {
						const res = await fetch("/api/gateway/chat", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ sessionKey: gatewaySessionKey, message: messageText }),
						});
						if (res.ok && res.body) {
							await attemptReconnect(gatewaySessionKey, [], { sessionKey: gatewaySessionKey });
						}
					} catch { /* ignore */ }
				} else {
					void sendMessage({ text: messageText });
				}

				setTimeout(() => {
					editorRef.current?.focus();
				}, 200);
			},
			[
				attachedFiles,
				isStreaming,
				currentSessionId,
				createSession,
				onActiveSessionChange,
				onSessionsChange,
				filePath,
				fileContext,
				sendMessage,
				gatewaySessionKey,
				attemptReconnect,
				onConversationActivity,
				isSubagentMode,
				setMessages,
			],
		);

		// ── Queue flush: send the next queued message once the stream finishes ──
		const prevFlushStatusRef = useRef(status);
		useEffect(() => {
			const wasStreaming =
				prevFlushStatusRef.current === "streaming" ||
				prevFlushStatusRef.current === "submitted";
			const isNowReady = status === "ready";
			prevFlushStatusRef.current = status;

			if (wasStreaming && isNowReady && queuedMessages.length > 0) {
				const [next, ...rest] = queuedMessages;
				setQueuedMessages(rest);
				// Revoke blob URLs from queued attachments (no longer needed for thumbnails)
				for (const f of next.attachedFiles) {
					if (f.localUrl) {URL.revokeObjectURL(f.localUrl);}
				}
				// Use a microtask so React can settle the status update first.
				queueMicrotask(() => {
					void handleEditorSubmit(next.text, next.mentionedFiles, next.html, next.attachedFiles);
				});
			}
		}, [status, queuedMessages, handleEditorSubmit]);

		const handleSessionSelect = useCallback(
			async (sessionId: string) => {
				if (sessionId === currentSessionId) {
					return;
				}

			// Stop any active stream/reconnection for the old session.
			reconnectAbortRef.current?.abort();
			void stop();

				setLoadingSession(true);
				setCurrentSessionId(sessionId);
				sessionIdRef.current = sessionId;
				onActiveSessionChange?.(sessionId);
				savedMessageIdsRef.current.clear();
				isFirstFileMessageRef.current = false;
				setQueuedMessages([]);

				try {
					const response = await fetch(
						`/api/web-sessions/${sessionId}`,
					);
					if (!response.ok) {
						console.warn(`Session ${sessionId} not found (${response.status}), starting fresh.`);
						setMessages([]);
						setLoadingSession(false);
						return;
					}

					const data = await response.json();
					const sessionMessages: Array<{
						id: string;
						role: "user" | "assistant";
						content: string;
						parts?: Array<Record<string, unknown>>;
						html?: string;
						_streaming?: boolean;
					}> = data.messages || [];

					const hasStreaming = sessionMessages.some(
						(m) => m._streaming,
					);
					const completedMessages = hasStreaming
						? sessionMessages.filter(
								(m) => !m._streaming,
							)
						: sessionMessages;

					userHtmlMapRef.current.clear();
					for (const msg of completedMessages) {
						if (msg.role === "user" && msg.html) {
							userHtmlMapRef.current.set(msg.id, msg.html);
						}
					}

					const uiMessages = completedMessages.map(
						(msg) => {
							savedMessageIdsRef.current.add(msg.id);
							return {
								id: msg.id,
								role: msg.role,
								parts: (msg.parts ?? [
									{
										type: "text" as const,
										text: msg.content,
									},
								]) as UIMessage["parts"],
							};
						},
					);

					setMessages(uiMessages);

					// Clear loading state *before* reconnecting — the
					// persisted messages are now visible.  attemptReconnect
					// manages its own `isReconnecting` state which shows
					// "Resuming stream..." instead of "Loading session...".
					setLoadingSession(false);

					// Always try to reconnect -- the stream endpoint
					// returns 404 gracefully if no active run exists,
					// and this avoids missing runs whose _streaming
					// flag hasn't been persisted yet.
					await attemptReconnect(sessionId, uiMessages);
				} catch (err) {
					console.error("Error loading session:", err);
					setLoadingSession(false);
				}
			},
			[
				currentSessionId,
				setMessages,
				onActiveSessionChange,
				stop,
				attemptReconnect,
			],
		);

		const handleNewSession = useCallback(() => {
			reconnectAbortRef.current?.abort();
			void stop();
			setIsReconnecting(false);
			setCurrentSessionId(null);
			sessionIdRef.current = null;
			onActiveSessionChange?.(null);
			setMessages([]);
			savedMessageIdsRef.current.clear();
			userHtmlMapRef.current.clear();
			isFirstFileMessageRef.current = true;
			newSessionPendingRef.current = false;
			setQueuedMessages([]);
			requestAnimationFrame(() => {
				editorRef.current?.focus();
			});
		}, [setMessages, onActiveSessionChange, stop]);

		// Keep the ref in sync so handleEditorSubmit can call it
		handleNewSessionRef.current = handleNewSession;

		useImperativeHandle(
			ref,
			() => ({
			loadSession: handleSessionSelect,
			newSession: async () => { handleNewSession(); },
				sendNewMessage: async (text: string) => {
					onConversationActivity?.();
					handleNewSession();
					const title =
						text.length > 60 ? text.slice(0, 60) + "..." : text;
					const sessionId = await createSession(title);
					setCurrentSessionId(sessionId);
					sessionIdRef.current = sessionId;
					onActiveSessionChange?.(sessionId);
					onSessionsChange?.();
					userScrolledAwayRef.current = false;
					void sendMessage({ text });
				},
				insertFileMention: (name: string, path: string) => {
					editorRef.current?.insertFileMention(name, path);
				},
			}),
			[handleSessionSelect, handleNewSession, createSession, onActiveSessionChange, onSessionsChange, onConversationActivity, sendMessage],
		);

		// ── Stop handler (aborts server-side run + client-side stream) ──
		const handleStop = useCallback(async () => {
			// Abort reconnection stream if active (immediate visual feedback).
			reconnectAbortRef.current?.abort();
			setIsReconnecting(false);

			// Read from refs to avoid stale closures — sessionIdRef is updated
			// synchronously in handleEditorSubmit, so it's always current even
			// if React hasn't re-rendered with the new state yet.
			const sk = subagentSessionKeyRef.current;
			const sid = sessionIdRef.current;
			const stopKey = sk || sid;
			if (stopKey) {
				try {
					await fetch("/api/chat/stop", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
						},
						body: JSON.stringify(
							sk
								? { sessionKey: sk }
								: { sessionId: sid },
						),
					});
				} catch { /* ignore */ }
			}

			// Stop the useChat transport stream (transitions status → "ready").
			void stop();
		}, [stop]);

		// ── Queue handlers ──

		const removeQueuedMessage = useCallback((id: string) => {
			setQueuedMessages((prev) => prev.filter((m) => m.id !== id));
		}, []);

		const updateQueuedMessageText = useCallback((id: string, text: string) => {
			setQueuedMessages((prev) => prev.map((m) => m.id === id ? { ...m, text } : m));
		}, []);

		/** Force-send: stop the agent, then immediately submit this queued message. */
		const forceSendQueuedMessage = useCallback(
			async (id: string) => {
				const msg = queuedMessages.find((m) => m.id === id);
				if (!msg) {return;}
				// Remove it from the queue first.
				setQueuedMessages((prev) => prev.filter((m) => m.id !== id));
				// Stop the current agent run.
				await handleStop();
				// Submit the message after a short delay to let status settle.
				setTimeout(() => {
					void handleEditorSubmit(msg.text, msg.mentionedFiles, msg.html, msg.attachedFiles);
				}, 100);
			},
			[queuedMessages, handleStop, handleEditorSubmit],
		);

		// ── Attachment handlers ──

		const removeAttachment = useCallback((id: string) => {
			setAttachedFiles((prev) => {
				const removed = prev.find((f) => f.id === id);
				if (removed?.localUrl) {URL.revokeObjectURL(removed.localUrl);}
				return prev.filter((f) => f.id !== id);
			});
		}, []);

		const clearAllAttachments = useCallback(() => {
			setAttachedFiles((prev) => {
				for (const f of prev) {
					if (f.localUrl) {URL.revokeObjectURL(f.localUrl);}
				}
				return [];
			});
		}, []);

		/** Upload native files (e.g. dropped from Finder/Desktop) and attach them.
		 *  Shows files instantly with a local preview, then uploads in the background. */
		const uploadAndAttachNativeFiles = useCallback(
			(files: FileList) => {
				const fileArray = Array.from(files);

				// Immediately add placeholder entries with local blob URLs
				const placeholders: AttachedFile[] = fileArray.map((file) => ({
					id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
					name: file.name,
					path: "",
					uploading: true,
					localUrl: URL.createObjectURL(file),
				}));
				setAttachedFiles((prev) => [...prev, ...placeholders]);

				// Upload each file in the background and update the entry
				for (let i = 0; i < fileArray.length; i++) {
					const file = fileArray[i];
					const placeholderId = placeholders[i].id;
					const localUrl = placeholders[i].localUrl;

					const form = new FormData();
					form.append("file", file);
					fetch("/api/workspace/upload", {
						method: "POST",
						body: form,
					})
						.then((res) => res.ok ? res.json() : null)
						.then((json: { ok?: boolean; path?: string } | null) => {
							if (json?.ok && json.path) {
								// Replace placeholder with the real uploaded file
								setAttachedFiles((prev) =>
									prev.map((f) =>
										f.id === placeholderId
											? { ...f, path: json.path!, uploading: false }
											: f,
									),
								);
							} else {
								// Upload failed — remove the placeholder
								setAttachedFiles((prev) => prev.filter((f) => f.id !== placeholderId));
								if (localUrl) {URL.revokeObjectURL(localUrl);}
							}
						})
						.catch(() => {
							setAttachedFiles((prev) => prev.filter((f) => f.id !== placeholderId));
							if (localUrl) {URL.revokeObjectURL(localUrl);}
						});
				}
			},
			[],
		);

		// ── Active stream status row ──

		const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
		const lastAssistantHasText = hasAssistantText(lastMsg);
		const streamActivityLabel = getStreamActivityLabel({
			loadingSession,
			isReconnecting,
			status,
			hasRunningSubagents,
			lastMessage: lastMsg,
		});
		const showStreamActivity = isStreaming && !!streamActivityLabel;

		const showHeroState = messages.length === 0 && (!compact || !fileContext) && !isSubagentMode && !loadingSession;

		// ── Input bar content (shared between hero and bottom positions) ──

		const inputBarContent = (
			<>
				{queuedMessages.length > 0 && (
					<div className={compact ? "px-2 pt-2" : "px-3 pt-3"}>
						<div
							className="rounded-xl border overflow-hidden"
							style={{
								background: "var(--color-surface)",
								borderColor: "var(--color-border)",
								boxShadow: "var(--shadow-sm)",
							}}
						>
							<div
								className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
								style={{ color: "var(--color-text-muted)", background: "var(--color-surface-hover)" }}
							>
								Queue ({queuedMessages.length})
							</div>
							<div className="flex flex-col p-2">
								{queuedMessages.map((msg, idx) => (
									<QueueItem
										key={msg.id}
										msg={msg}
										idx={idx}
										onEdit={updateQueuedMessageText}
										onSendNow={forceSendQueuedMessage}
										onRemove={removeQueuedMessage}
									/>
								))}
							</div>
						</div>
					</div>
				)}

				{!isSubagentMode && (
					<AttachmentStrip
						files={attachedFiles}
						compact={compact}
						onRemove={removeAttachment}
						onClearAll={clearAllAttachments}
					/>
				)}

				<ChatEditor
					ref={editorRef}
					onSubmit={handleEditorSubmit}
					onChange={(isEmpty) => setEditorEmpty(isEmpty)}
					onNativeFileDrop={isSubagentMode ? undefined : uploadAndAttachNativeFiles}
					placeholder={
						showHeroState
							? "Build a workflow to automate your tasks"
							: isSubagentMode
								? (isStreaming ? "Type to queue a message..." : "Type @ to mention files...")
								: compact && fileContext
									? `Ask about ${fileContext.isDirectory ? "this folder" : fileContext.filename}...`
									: isStreaming
										? "Type to queue a message..."
										: attachedFiles.length > 0
											? "Add a message or send files..."
											: "Type @ to mention files..."
					}
					disabled={loadingSession}
					compact={compact}
				/>

				<div className={`flex items-center justify-between ${compact ? "px-2 pb-1.5" : "px-3 pb-2.5"}`}>
					<div className="flex items-center gap-0.5">
						{!isSubagentMode && (
							<>
								<input
									ref={fileInputRef}
									type="file"
									multiple
									className="hidden"
									onChange={(e) => {
										if (e.target.files && e.target.files.length > 0) {
											uploadAndAttachNativeFiles(e.target.files);
										}
										e.target.value = "";
									}}
								/>
								<button
									type="button"
									onClick={() => fileInputRef.current?.click()}
									className="p-1.5 rounded-lg hover:opacity-80 transition-opacity"
									style={{
										color: attachedFiles.length > 0 ? "var(--color-accent)" : "var(--color-text-muted)",
									}}
									title="Attach files"
								>
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
										<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
									</svg>
								</button>
							</>
						)}
					</div>
					<div className="flex items-center gap-1.5">
						<ChatVoiceInputButton
							compact={compact}
							disabled={loadingSession}
							preferServerTranscription={preferServerVoiceInput}
							onTranscript={handleVoiceTranscript}
						/>
						{isStreaming ? (
							<button
								type="button"
								onClick={() => handleStop()}
								className={`${compact ? "w-6 h-6" : "w-7 h-7"} rounded-full flex items-center justify-center`}
								style={{ background: "var(--color-text)", color: "var(--color-bg)" }}
								title="Stop generating"
							>
								<svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor">
									<rect width="10" height="10" rx="1.5" />
								</svg>
							</button>
						) : (
							<button
								type="button"
								onClick={() => editorRef.current?.submit()}
								disabled={
									(editorEmpty && attachedFiles.length === 0) ||
									loadingSession
								}
								className={`${compact ? "w-6 h-6" : "w-7 h-7"} rounded-full flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed`}
								style={{
									background: !editorEmpty || attachedFiles.length > 0 ? "linear-gradient(to top, #0065A2, #0075AA)" : "var(--color-text-muted)",
									color: !editorEmpty || attachedFiles.length > 0 ? "white" : "var(--color-bg)",
								}}
								title="Send message"
							>
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
									<path d="M12 19V5" />
									<path d="m5 12 7-7 7 7" />
								</svg>
							</button>
						)}
					</div>
				</div>
			</>
		);

		const inputBarContainer = (onDragOverHandler: React.DragEventHandler, onDragLeaveHandler: React.DragEventHandler, onDropHandler: React.DragEventHandler) => (
			<div
				data-chat-drop-target=""
				className={`${compact ? "rounded-2xl" : "rounded-3xl"} overflow-hidden border shadow-[0_0_32px_rgba(0,0,0,0.07)] transition-[outline,box-shadow,border-color] duration-150 ease-out focus-within:border-[var(--color-border-strong)]! data-drag-hover:outline-2 data-drag-hover:outline-dashed data-drag-hover:outline-(--color-accent) data-drag-hover:-outline-offset-2 data-drag-hover:shadow-[0_0_0_4px_color-mix(in_srgb,var(--color-accent)_15%,transparent),0_0_32px_rgba(0,0,0,0.07)]!`}
				style={{
					background: "var(--color-surface)",
					borderColor: "var(--color-border)",
				}}
				onDragOver={onDragOverHandler}
				onDragLeave={onDragLeaveHandler}
				onDrop={onDropHandler}
			>
				{inputBarContent}
			</div>
		);

		const handleInputDragOver: React.DragEventHandler = (e) => {
			if (
				e.dataTransfer?.types.includes("application/x-file-mention") ||
				e.dataTransfer?.types.includes("Files")
			) {
				e.preventDefault();
				e.dataTransfer.dropEffect = "copy";
				(e.currentTarget as HTMLElement).setAttribute("data-drag-hover", "");
			}
		};
		const handleInputDragLeave: React.DragEventHandler = (e) => {
			if (!e.currentTarget.contains(e.relatedTarget as Node)) {
				(e.currentTarget as HTMLElement).removeAttribute("data-drag-hover");
			}
		};
		const handleInputDrop: React.DragEventHandler = (e) => {
			(e.currentTarget as HTMLElement).removeAttribute("data-drag-hover");
			const data = e.dataTransfer?.getData("application/x-file-mention");
			if (data) {
				e.preventDefault();
				e.stopPropagation();
				try {
					const { name, path } = JSON.parse(data) as { name: string; path: string };
					if (name && path) {
						editorRef.current?.insertFileMention(name, path);
					}
				} catch { /* ignore */ }
				return;
			}
			const files = e.dataTransfer?.files;
			if (files && files.length > 0) {
				e.preventDefault();
				e.stopPropagation();
				uploadAndAttachNativeFiles(files);
			}
		};

		// ── Render ──

		return (
			<div
				className="h-full min-h-0 flex flex-col overflow-hidden"
				style={{ background: "var(--color-main-bg)" }}
			>
				{/* Header — sticky glass bar */}
				<header
					className={`${compact ? "px-3 py-2" : "px-3 py-2 md:px-6 md:py-3"} flex shrink-0 items-center ${isSubagentMode ? "gap-3" : "justify-between"} z-20`}
				>
				{isSubagentMode ? (
					<>
						<button
							type="button"
							onClick={onBack}
							className="p-1.5 rounded-lg flex-shrink-0"
							style={{ color: "var(--color-text-muted)" }}
							title="Back to parent chat"
						>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="m12 19-7-7 7-7" />
								<path d="M19 12H5" />
							</svg>
						</button>
						<div className="min-w-0 flex-1">
							<h2 className="text-sm font-semibold truncate" style={{ color: "var(--color-text)" }}>
								{subagentLabel || (subagentTask && subagentTask.length > 60 ? subagentTask.slice(0, 60) + "..." : subagentTask)}
							</h2>
							<p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
								{isStreaming ? <UnicodeSpinner name="braille" /> : "Completed"}
							</p>
						</div>
					</>
				) : (
					<>
					<div className="min-w-0 flex-1">
						{compact && fileContext ? (
							<h2
								className="text-xs font-semibold truncate"
								style={{
									color: "var(--color-text)",
								}}
							>
								Chat: {fileContext.filename}
							</h2>
						) : currentSessionId ? (
							<h2
								className="text-sm font-semibold"
								style={{
									color: "var(--color-text)",
								}}
							>
								{sessionTitle || "Chat Session"}
							</h2>
						) : null}
					</div>
					{!hideHeaderActions && (
					<div className="flex items-center gap-1 shrink-0">
						{currentSessionId && onDeleteSession && (
							<DropdownMenu>
								<DropdownMenuTrigger
									className="p-1.5 rounded-lg"
									style={{ color: "var(--color-text-muted)" }}
									title="More options"
									aria-label="More options"
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
										<circle cx="12" cy="12" r="1" />
										<circle cx="5" cy="12" r="1" />
										<circle cx="19" cy="12" r="1" />
									</svg>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" side="bottom">
									<DropdownMenuItem
										variant="destructive"
										onSelect={() => onDeleteSession(currentSessionId)}
									>
										<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>
										Delete this chat
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						)}
						<button
								type="button"
								onClick={() => handleNewSession()}
								className="p-1.5 rounded-lg"
								style={{
									color: "var(--color-text-muted)",
								}}
								title="New chat"
							>
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
									<path d="M12 5v14" />
									<path d="M5 12h14" />
								</svg>
							</button>
					</div>
					)}
					</>
				)}
				</header>

				{/* File-scoped session tabs (compact mode, not in subagent mode) */}
				{!isSubagentMode && compact && fileContext && fileSessions.length > 0 && (
					<div
						className="px-2 py-1.5 border-b flex shrink-0 gap-1 overflow-x-auto z-20"
						style={{
							borderColor: "var(--color-border)",
							background: "var(--color-bg-glass)",
						}}
					>
						{fileSessions.slice(0, 10).map((s) => (
							<button
								key={s.id}
								type="button"
								onClick={() =>
									handleSessionSelect(s.id)
								}
								className="px-2.5 py-1 text-[10px] rounded-full whitespace-nowrap shrink-0 font-medium"
								style={{
									background:
										s.id === currentSessionId
											? "var(--color-accent)"
											: "var(--color-surface-hover)",
									color:
										s.id === currentSessionId
											? "white"
											: "var(--color-text-muted)",
									border:
										s.id === currentSessionId
											? "none"
											: "1px solid var(--color-border)",
								}}
							>
								{s.title.length > 25
									? s.title.slice(0, 25) + "..."
									: s.title}
							</button>
						))}
					</div>
				)}

				<div
					ref={scrollContainerRef}
					className="min-h-0 min-w-0 flex-1 overflow-y-auto"
					style={{ scrollbarGutter: "stable" }}
				>
				{/* Messages */}
				<div
					className={compact ? "px-3" : "px-6"}
				>
					{loadingSession ? (
						<div className="flex items-center justify-center h-full min-h-[60vh]">
							<div className="text-center">
								<UnicodeSpinner
									name="braille"
									className="block text-2xl mx-auto mb-3"
									style={{ color: "var(--color-text-muted)" }}
								/>
								<p
									className="text-xs"
									style={{
										color: "var(--color-text-muted)",
									}}
								>
									Loading session...
								</p>
							</div>
						</div>
					) : (showHeroState && !mounted) ? (
						<div className={`flex items-center justify-center h-full ${compact ? "min-h-[40vh]" : "min-h-[60vh]"}`} />
					) : showHeroState ? (
						<div className={`flex flex-col items-center justify-center py-8 md:py-12 ${compact ? "min-h-[60vh]" : "min-h-[75vh]"}`}>
							{/* Hero greeting */}
							{greeting && (
								<h1
									className="text-3xl md:text-5xl font-light tracking-normal font-instrument mb-6 md:mb-10 text-center px-4"
									style={{ color: "var(--color-text)" }}
								>
									{greeting}
								</h1>
							)}

							{/* Centered input bar */}
							<div className="w-full max-w-[720px] mx-auto px-3 md:px-4">
								{inputBarContainer(handleInputDragOver, handleInputDragLeave, handleInputDrop)}
							</div>

							{/* Prompt suggestion pills */}
							<HeroSuggestions
								compact={!!compact}
								onPromptClick={handlePromptClick}
							/>
						</div>
					) : messages.length === 0 ? (
						<div className="flex items-center justify-center h-full min-h-[60vh]">
							<div className="text-center max-w-md px-4">
								<p
									className="text-sm"
									style={{
										color: "var(--color-text-muted)",
									}}
								>
									Ask about this file
								</p>
							</div>
						</div>
					) : (
						<div
							className={`${compact ? "" : "max-w-2xl mx-auto"} py-3`}
						>
						{rawView ? (
							<pre
								className="text-xs whitespace-pre-wrap break-all font-mono p-4 rounded-xl"
								style={{ color: "var(--color-text)", background: "var(--color-surface-hover)" }}
							>
								{JSON.stringify(messages, null, 2)}
							</pre>
						) : messages.map((message, i) => (
							<ChatMessage
								key={message.id}
								message={message}
								isStreaming={isStreaming && i === messages.length - 1}
								onSubagentClick={onSubagentClick}
								onFilePathClick={onFilePathClick}
								onComposioAction={onComposioAction}
								sessionId={currentSessionId}
								voicePlaybackEnabled={voicePlaybackEnabled}
								userHtmlMap={userHtmlMapRef.current}
								copyable
							/>
						))}
						{showStreamActivity && (
							<div className="py-3 min-w-0">
								<div
									className="inline-flex max-w-full items-center gap-2 rounded-full px-3 py-1.5"
									style={{
										background: "var(--color-surface-hover)",
										border: "1px solid var(--color-border)",
										color: "var(--color-text-muted)",
									}}
								>
									<UnicodeSpinner
										name="braille"
										className={`text-sm ${lastAssistantHasText ? "" : "opacity-90"}`}
										style={{ color: "inherit" }}
									/>
									<span className="text-xs truncate">
										{streamActivityLabel}
									</span>
								</div>
							</div>
						)}
							<div ref={messagesEndRef} />
						</div>
					)}
				</div>

				{/* Transport / stream-level error display */}
				{(error || streamError) && (
					<div
						className="px-3 py-2 flex items-center gap-2 sticky bottom-[72px] z-10"
						style={{
							background: `color-mix(in srgb, var(--color-error) 6%, var(--color-surface))`,
							borderColor: `color-mix(in srgb, var(--color-error) 18%, transparent)`,
							color: "var(--color-error)",
						}}
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
							className="shrink-0"
						>
							<circle cx="12" cy="12" r="10" />
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
						<p className="text-xs">{error?.message ?? streamError}</p>
					</div>
				)}
				</div>

				{/* Scroll to bottom button */}
				{showScrollButton && !showHeroState && (
					<div className="flex justify-center pointer-events-none" style={{ marginTop: -80, marginBottom: 4, position: "relative", zIndex: 20 }}>
						<button
							type="button"
							onClick={scrollToBottom}
							className="pointer-events-auto w-8 h-8 rounded-full flex items-center justify-center shadow-md border backdrop-blur-xl transition-colors"
							style={{
								background: "color-mix(in srgb, var(--color-surface) 70%, transparent)",
								borderColor: "var(--color-border)",
								color: "var(--color-text-muted)",
							}}
							title="Scroll to bottom"
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M12 5v14" />
								<path d="m19 12-7 7-7-7" />
							</svg>
						</button>
					</div>
				)}

				{/* Input bar at bottom (hidden when hero state is active) */}
				{!showHeroState && (
					<div
						className={`${compact ? "px-3 py-2" : "px-3 pb-3 pt-0 md:px-6 md:pb-5"} shrink-0 z-20`}
						style={{ background: "var(--color-bg-glass)" }}
					>
						<div className={compact ? "" : "max-w-[720px] mx-auto"}>
							{inputBarContainer(handleInputDragOver, handleInputDragLeave, handleInputDrop)}
						</div>
					</div>
				)}

				</div>
		);
	},
);
