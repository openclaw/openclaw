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
import { ChatMessage } from "./chat-message";
import {
	FilePickerModal,
	type SelectedFile,
} from "./file-picker-modal";
import { ChatEditor, type ChatEditorHandle } from "./tiptap/chat-editor";

// ── Attachment types & helpers ──

type AttachedFile = {
	id: string;
	name: string;
	path: string;
};

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

function AttachmentStrip({
	files,
	compact,
	onRemove,
	onClearAll,
}: {
	files: AttachedFile[];
	compact?: boolean;
	onRemove: (id: string) => void;
	onClearAll: () => void;
}) {
	if (files.length === 0) {return null;}

	return (
		<div className={`${compact ? "px-2" : "px-3"} pb-2`}>
			<div className="flex items-center justify-between mb-1.5">
				<span
					className="text-[10px] font-medium uppercase tracking-wider"
					style={{ color: "var(--color-text-muted)" }}
				>
					{files.length}{" "}
					{files.length === 1 ? "file" : "files"} attached
				</span>
				{files.length > 1 && (
					<button
						type="button"
						onClick={onClearAll}
						className="text-[10px] font-medium px-1.5 py-0.5 rounded hover:opacity-80 transition-opacity"
						style={{ color: "var(--color-text-muted)" }}
					>
						Clear all
					</button>
				)}
			</div>
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
								className="absolute top-1 right-1 z-10 w-[18px] h-[18px] rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
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

							<div className="flex items-center gap-2.5 px-3 py-2.5">
								<div
									className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
									style={{
										background:
											meta.bg,
										color: meta.fg,
									}}
								>
									<FileTypeIcon
										category={
											category
										}
									/>
								</div>
								<div className="min-w-0 max-w-[140px]">
									<p
										className="text-[11px] font-medium truncate"
										style={{
											color: "var(--color-text)",
										}}
										title={
											af.path
										}
									>
										{af.name}
									</p>
									<p
										className="text-[9px] truncate"
										style={{
											color: "var(--color-text-muted)",
										}}
										title={
											af.path
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

// ── SSE stream parser for reconnection ──
// Converts raw SSE events (AI SDK v6 wire format) into UIMessage parts.

type ParsedPart =
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string; state?: string }
	| {
			type: "dynamic-tool";
			toolName: string;
			toolCallId: string;
			state: string;
			input?: Record<string, unknown>;
			output?: Record<string, unknown>;
		};

function createStreamParser() {
	const parts: ParsedPart[] = [];
	let currentTextIdx = -1;
	let currentReasoningIdx = -1;

	function processEvent(event: Record<string, unknown>) {
		const t = event.type as string;

		switch (t) {
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
			case "tool-output-available":
				for (let i = parts.length - 1; i >= 0; i--) {
					const p = parts[i];
					if (
						p.type === "dynamic-tool" &&
						p.toolCallId === event.toolCallId
					) {
						p.state = "output-available";
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
	/** Insert a file mention into the chat editor (e.g. from sidebar drag). */
	insertFileMention?: (name: string, path: string) => void;
};

export type FileContext = {
	path: string;
	filename: string;
};

type FileScopedSession = {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
};

type ChatPanelProps = {
	/** When set, scopes sessions to this file and prepends content as context. */
	fileContext?: FileContext;
	/** Compact mode for workspace sidebar (smaller UI, built-in session tabs). */
	compact?: boolean;
	/** Called when file content may have changed after agent edits. */
	onFileChanged?: (newContent: string) => void;
	/** Called when active session changes (for external sidebar highlighting). */
	onActiveSessionChange?: (sessionId: string | null) => void;
	/** Called when session list needs refresh (for external sidebar). */
	onSessionsChange?: () => void;
};

export const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(
	function ChatPanel(
		{
			fileContext,
			compact,
			onFileChanged,
			onActiveSessionChange,
			onSessionsChange,
		},
		ref,
	) {
		const editorRef = useRef<ChatEditorHandle>(null);
		const [editorEmpty, setEditorEmpty] = useState(true);
		const [currentSessionId, setCurrentSessionId] = useState<
			string | null
		>(null);
		const [loadingSession, setLoadingSession] = useState(false);
		const [startingNewSession, setStartingNewSession] = useState(false);
		const messagesEndRef = useRef<HTMLDivElement>(null);

		// ── Attachment state ──
		const [attachedFiles, setAttachedFiles] = useState<
			AttachedFile[]
		>([]);
		const [showFilePicker, setShowFilePicker] =
			useState(false);

		// ── Reconnection state ──
		const [isReconnecting, setIsReconnecting] = useState(false);
		const reconnectAbortRef = useRef<AbortController | null>(null);

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

		const filePath = fileContext?.path ?? null;

		// ── Ref-based session ID for transport ──
		const sessionIdRef = useRef<string | null>(null);
		useEffect(() => {
			sessionIdRef.current = currentSessionId;
		}, [currentSessionId]);

		// ── Transport (per-instance) ──
		const transport = useMemo(
			() =>
				new DefaultChatTransport({
					api: "/api/chat",
					body: () => {
						const sid = sessionIdRef.current;
						return sid ? { sessionId: sid } : {};
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

		// Auto-scroll to bottom on new messages
		useEffect(() => {
			messagesEndRef.current?.scrollIntoView({
				behavior: "smooth",
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
		const attemptReconnect = useCallback(
			async (
				sessionId: string,
				baseMessages: Array<{
					id: string;
					role: "user" | "assistant" | "system";
					parts: UIMessage["parts"];
				}>,
			): Promise<boolean> => {
				const abort = new AbortController();
				reconnectAbortRef.current = abort;

				try {
					const res = await fetch(
						`/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}`,
						{ signal: abort.signal },
					);
					if (!res.ok || !res.body) {
						return false; // No active run
					}

					setIsReconnecting(true);

					const parser = createStreamParser();
					const reader = res.body.getReader();
					const decoder = new TextDecoder();
					const reconnectMsgId = `reconnect-${sessionId}`;
					let buffer = "";
					let frameRequested = false;

					const updateUI = () => {
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
					for (const m of baseMessages) {
						savedMessageIdsRef.current.add(m.id);
					}
					savedMessageIdsRef.current.add(reconnectMsgId);

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
			if (!filePath) {
				return;
			}
			let cancelled = false;

			sessionIdRef.current = null;
			setCurrentSessionId(null);
			onActiveSessionChange?.(null);
			setMessages([]);
			savedMessageIdsRef.current.clear();
			isFirstFileMessageRef.current = true;

			(async () => {
				const sessions =
					(await fetchFileSessionsRef.current?.()) ?? [];
				if (cancelled) {
					return;
				}
				setFileSessions(sessions);

				if (sessions.length > 0) {
					const latest = sessions[0];
					setCurrentSessionId(latest.id);
					sessionIdRef.current = latest.id;
					onActiveSessionChange?.(latest.id);
					isFirstFileMessageRef.current = false;

					try {
						const msgRes = await fetch(
							`/api/web-sessions/${latest.id}`,
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
							_streaming?: boolean;
						}> = msgData.messages || [];

						// Filter out in-progress streaming messages
						// (will be rebuilt from the live SSE stream)
						const hasStreaming = sessionMessages.some(
							(m) => m._streaming,
						);
						const completedMessages = hasStreaming
							? sessionMessages.filter(
									(m) => !m._streaming,
								)
							: sessionMessages;

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

						// If there was a streaming message, try to
						// reconnect to the active agent run.
						if (hasStreaming && !cancelled) {
							await attemptReconnect(
								latest.id,
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

		// ── Post-stream side-effects (file-reload, session refresh) ──
		// Message persistence is handled server-side by ActiveRunManager,
		// so we only refresh the file sessions list and notify the parent
		// when the file content may have changed.
		const prevStatusRef = useRef(status);
		useEffect(() => {
			const wasStreaming =
				prevStatusRef.current === "streaming" ||
				prevStatusRef.current === "submitted";
			const isNowReady = status === "ready";

			if (wasStreaming && isNowReady && currentSessionId) {
				// Mark all current messages as saved — the server
				// already persisted them via ActiveRunManager.
				for (const m of messages) {
					savedMessageIdsRef.current.add(m.id);
				}

				if (filePath) {
					fetchFileSessionsRef.current?.().then(
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
			prevStatusRef.current = status;
		}, [
			status,
			messages,
			currentSessionId,
			filePath,
			onFileChanged,
			onSessionsChange,
		]);

		// ── Actions ──

		// Ref for handleNewSession so handleEditorSubmit doesn't depend on the hook order
		const handleNewSessionRef = useRef<() => void>(() => {});

		/** Submit from the Tiptap editor (called on Enter or send button). */
		const handleEditorSubmit = useCallback(
			async (
				text: string,
				mentionedFiles: Array<{ name: string; path: string }>,
			) => {
				const hasText = text.trim().length > 0;
				const hasMentions = mentionedFiles.length > 0;
				const hasFiles = attachedFiles.length > 0;
				if ((!hasText && !hasMentions && !hasFiles) || isStreaming) {
					return;
				}

				const userText = text.trim();
				const currentAttachments = [...attachedFiles];

				// Clear attachments
				if (currentAttachments.length > 0) {
					setAttachedFiles([]);
				}

				if (userText.toLowerCase() === "/new") {
					handleNewSessionRef.current();
					return;
				}

				let sessionId = currentSessionId;
				if (!sessionId) {
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
						fetchFileSessionsRef.current?.().then(
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
					messageText = `[Context: workspace file '${fileContext.path}']\n\n${messageText}`;
					isFirstFileMessageRef.current = false;
				}

				sendMessage({ text: messageText });
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
			],
		);


		const handleSessionSelect = useCallback(
			async (sessionId: string) => {
				if (sessionId === currentSessionId) {
					return;
				}

				// Stop any active stream/reconnection for the old session.
				reconnectAbortRef.current?.abort();
				stop();

				setLoadingSession(true);
				setCurrentSessionId(sessionId);
				sessionIdRef.current = sessionId;
				onActiveSessionChange?.(sessionId);
				savedMessageIdsRef.current.clear();
				isFirstFileMessageRef.current = false;

				try {
					const response = await fetch(
						`/api/web-sessions/${sessionId}`,
					);
					if (!response.ok) {
						throw new Error("Failed to load session");
					}

					const data = await response.json();
					const sessionMessages: Array<{
						id: string;
						role: "user" | "assistant";
						content: string;
						parts?: Array<Record<string, unknown>>;
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

					// Reconnect to active stream if one exists.
					if (hasStreaming) {
						await attemptReconnect(
							sessionId,
							uiMessages,
						);
					}
				} catch (err) {
					console.error("Error loading session:", err);
				} finally {
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

		const handleNewSession = useCallback(async () => {
			reconnectAbortRef.current?.abort();
			stop();
			setIsReconnecting(false);
			setCurrentSessionId(null);
			sessionIdRef.current = null;
			onActiveSessionChange?.(null);
			setMessages([]);
			savedMessageIdsRef.current.clear();
			isFirstFileMessageRef.current = true;
			newSessionPendingRef.current = false;

			if (!filePath) {
				setStartingNewSession(true);
				try {
					await fetch("/api/new-session", {
						method: "POST",
					});
				} catch (err) {
					console.error("Failed to send /new:", err);
				} finally {
					setStartingNewSession(false);
				}
			}
		}, [setMessages, onActiveSessionChange, filePath, stop]);

		// Keep the ref in sync so handleEditorSubmit can call it
		handleNewSessionRef.current = handleNewSession;

		useImperativeHandle(
			ref,
			() => ({
				loadSession: handleSessionSelect,
				newSession: handleNewSession,
				insertFileMention: (name: string, path: string) => {
					editorRef.current?.insertFileMention(name, path);
				},
			}),
			[handleSessionSelect, handleNewSession],
		);

		// ── Stop handler (aborts server-side run + client-side stream) ──
		const handleStop = useCallback(async () => {
			// Abort the server-side agent run
			if (currentSessionId) {
				fetch("/api/chat/stop", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						sessionId: currentSessionId,
					}),
				}).catch(() => {});
			}

			// Abort reconnection stream if active
			reconnectAbortRef.current?.abort();
			setIsReconnecting(false);

			// Stop the useChat transport stream
			stop();
		}, [currentSessionId, stop]);

		// ── Attachment handlers ──

		const handleFilesSelected = useCallback(
			(files: SelectedFile[]) => {
				const newFiles: AttachedFile[] = files.map(
					(f) => ({
						id: `${f.path}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
						name: f.name,
						path: f.path,
					}),
				);
				setAttachedFiles((prev) => [
					...prev,
					...newFiles,
				]);
			},
			[],
		);

		const removeAttachment = useCallback((id: string) => {
			setAttachedFiles((prev) =>
				prev.filter((f) => f.id !== id),
			);
		}, []);

		const clearAllAttachments = useCallback(() => {
			setAttachedFiles([]);
		}, []);

		// ── Status label ──

		const statusLabel = startingNewSession
			? "Starting new session..."
			: loadingSession
				? "Loading session..."
				: isReconnecting
					? "Resuming stream..."
					: status === "ready"
						? "Ready"
						: status === "submitted"
							? "Thinking..."
							: status === "streaming"
								? "Streaming..."
								: status === "error"
									? "Error"
									: status;

		// ── Render ──

		return (
			<div className="flex flex-col h-full">
				{/* Header */}
				<header
					className={`${compact ? "px-3 py-2" : "px-6 py-3"} border-b flex items-center justify-between flex-shrink-0`}
					style={{
						borderColor: "var(--color-border)",
						background: "var(--color-surface)",
					}}
				>
					<div className="min-w-0 flex-1">
						{compact && fileContext ? (
							<>
								<h2
									className="text-xs font-semibold truncate"
									style={{
										color: "var(--color-text)",
									}}
								>
									Chat: {fileContext.filename}
								</h2>
								<p
									className="text-[10px]"
									style={{
										color: "var(--color-text-muted)",
									}}
								>
									{statusLabel}
								</p>
							</>
						) : (
							<>
								<h2
									className="text-sm font-semibold"
									style={{
										color: "var(--color-text)",
									}}
								>
									{currentSessionId
										? "Chat Session"
										: "New Chat"}
								</h2>
								<p
									className="text-xs"
									style={{
										color: "var(--color-text-muted)",
									}}
								>
									{statusLabel}
								</p>
							</>
						)}
					</div>
					<div className="flex gap-1 flex-shrink-0">
						{compact && (
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
						)}
						{isStreaming && (
							<button
								type="button"
								onClick={() => handleStop()}
								className={`${compact ? "px-2 py-0.5 text-[10px]" : "px-3 py-1 text-xs"} rounded-full font-medium`}
								style={{
									background:
										"var(--color-surface-hover)",
									color: "var(--color-text)",
									border: "1px solid var(--color-border)",
								}}
							>
								Stop
							</button>
						)}
					</div>
				</header>

				{/* File-scoped session tabs (compact mode) */}
				{compact && fileContext && fileSessions.length > 0 && (
					<div
						className="px-2 py-1.5 border-b flex gap-1 overflow-x-auto flex-shrink-0"
						style={{
							borderColor: "var(--color-border)",
						}}
					>
						{fileSessions.slice(0, 10).map((s) => (
							<button
								key={s.id}
								type="button"
								onClick={() =>
									handleSessionSelect(s.id)
								}
								className="px-2.5 py-1 text-[10px] rounded-full whitespace-nowrap flex-shrink-0 font-medium"
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

				{/* Messages */}
				<div
					className={`flex-1 overflow-y-auto ${compact ? "px-3" : "px-6"}`}
				>
					{loadingSession ? (
						<div className="flex items-center justify-center h-full">
							<div className="text-center">
								<div
									className="w-6 h-6 border-2 rounded-full animate-spin mx-auto mb-3"
									style={{
										borderColor:
											"var(--color-border)",
										borderTopColor:
											"var(--color-accent)",
									}}
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
					) : messages.length === 0 ? (
						<div className="flex items-center justify-center h-full">
							<div className="text-center max-w-md px-4">
								{compact ? (
									<p
										className="text-sm"
										style={{
											color: "var(--color-text-muted)",
										}}
									>
										Ask about this file
									</p>
								) : (
									<>
										<h3
											className="font-instrument text-3xl tracking-tight mb-2"
											style={{
												color: "var(--color-text)",
											}}
										>
											What can I help with?
										</h3>
										<p
											className="text-sm leading-relaxed"
											style={{
												color: "var(--color-text-muted)",
											}}
										>
											Send a message to start a
											conversation with your
											agent.
										</p>
									</>
								)}
							</div>
						</div>
					) : (
						<div
							className={`${compact ? "" : "max-w-3xl mx-auto"} py-3`}
						>
							{messages.map((message, i) => (
								<ChatMessage
									key={message.id}
									message={message}
									isStreaming={isStreaming && i === messages.length - 1}
								/>
							))}
							<div ref={messagesEndRef} />
						</div>
					)}
				</div>

				{/* Transport-level error display */}
				{error && (
					<div
						className="px-3 py-2 border-t flex-shrink-0 flex items-center gap-2"
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
							className="flex-shrink-0"
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
						<p className="text-xs">{error.message}</p>
					</div>
				)}

				{/* Input — Dench-style rounded area with toolbar */}
				<div
					className={`${compact ? "px-3 py-2" : "px-6 py-4"} flex-shrink-0`}
					style={{ background: "var(--color-bg)" }}
				>
					<div
						className={`${compact ? "" : "max-w-3xl mx-auto"}`}
					>
						<div
							className="rounded-2xl overflow-hidden"
							style={{
								background:
									"var(--color-chat-input-bg)",
								border: "1px solid var(--color-border)",
							}}
						>
							<ChatEditor
								ref={editorRef}
								onSubmit={handleEditorSubmit}
								onChange={(isEmpty) =>
									setEditorEmpty(isEmpty)
								}
								placeholder={
									compact && fileContext
										? `Ask about ${fileContext.filename}...`
										: attachedFiles.length >
												0
											? "Add a message or send files..."
											: "Type @ to mention files..."
								}
								disabled={
									isStreaming ||
									loadingSession ||
									startingNewSession
								}
								compact={compact}
							/>

						{/* Attachment preview strip */}
						<AttachmentStrip
							files={attachedFiles}
							compact={compact}
							onRemove={removeAttachment}
							onClearAll={
								clearAllAttachments
							}
						/>

						{/* Toolbar row */}
							<div
								className={`flex items-center justify-between ${compact ? "px-2 pb-1.5" : "px-3 pb-2.5"}`}
							>
							<div className="flex items-center gap-0.5">
								<button
									type="button"
									onClick={() =>
										setShowFilePicker(
											true,
										)
									}
									className="p-1.5 rounded-lg hover:opacity-80 transition-opacity"
									style={{
										color:
											attachedFiles.length >
											0
												? "var(--color-accent)"
												: "var(--color-text-muted)",
									}}
									title="Attach files"
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
											<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
										</svg>
									</button>
								</div>
							{/* Send button */}
							<button
								type="button"
								onClick={() => {
									editorRef.current?.submit();
								}}
								disabled={
									(editorEmpty &&
										attachedFiles.length ===
											0) ||
									isStreaming ||
									loadingSession ||
									startingNewSession
								}
								className={`${compact ? "w-6 h-6" : "w-7 h-7"} rounded-full flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed`}
								style={{
									background:
										!editorEmpty ||
										attachedFiles.length >
											0
											? "var(--color-accent)"
											: "var(--color-border-strong)",
									color: "white",
								}}
								>
									{isStreaming ? (
										<div
											className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"
										/>
									) : (
										<svg
											width="14"
											height="14"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2.5"
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<path d="M12 19V5" />
											<path d="m5 12 7-7 7 7" />
										</svg>
									)}
								</button>
							</div>
						</div>
					</div>
				</div>

				{/* File picker modal */}
				<FilePickerModal
					open={showFilePicker}
					onClose={() =>
						setShowFilePicker(false)
					}
					onSelect={handleFilesSelected}
				/>
			</div>
		);
	},
);
