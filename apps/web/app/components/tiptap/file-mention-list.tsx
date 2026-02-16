"use client";

import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";

// ── Types ──

type SuggestItem = {
	name: string;
	path: string;
	type: "folder" | "file" | "document" | "database" | "object" | "entry";
	icon?: string;
	objectName?: string;
	entryId?: string;
};

export type FileMentionListRef = {
	onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};

type FileMentionListProps = {
	items: SuggestItem[];
	command: (item: SuggestItem) => void;
	loading?: boolean;
};

// ── File type helpers ──

type FileCategory =
	| "folder" | "image" | "video" | "audio" | "pdf" | "code"
	| "document" | "database" | "object" | "entry" | "other";

function getFileCategory(name: string, type: string): FileCategory {
	if (type === "folder") {return "folder";}
	if (type === "database") {return "database";}
	if (type === "object") {return "object";}
	if (type === "entry") {return "entry";}
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	if (
		["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "tiff", "heic"].includes(ext)
	)
		{return "image";}
	if (["mp4", "webm", "mov", "avi", "mkv", "flv"].includes(ext)) {return "video";}
	if (["mp3", "wav", "ogg", "aac", "flac", "m4a"].includes(ext)) {return "audio";}
	if (ext === "pdf") {return "pdf";}
	if (
		[
			"js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java",
			"cpp", "c", "h", "css", "html", "json", "yaml", "yml",
			"toml", "md", "sh", "bash", "sql", "swift", "kt",
		].includes(ext)
	)
		{return "code";}
	if (type === "document") {return "document";}
	return "other";
}

const categoryColors: Record<string, { bg: string; fg: string }> = {
	folder: { bg: "rgba(245, 158, 11, 0.12)", fg: "#f59e0b" },
	image: { bg: "rgba(16, 185, 129, 0.12)", fg: "#10b981" },
	video: { bg: "rgba(139, 92, 246, 0.12)", fg: "#8b5cf6" },
	audio: { bg: "rgba(245, 158, 11, 0.12)", fg: "#f59e0b" },
	pdf: { bg: "rgba(239, 68, 68, 0.12)", fg: "#ef4444" },
	code: { bg: "rgba(59, 130, 246, 0.12)", fg: "#3b82f6" },
	document: { bg: "rgba(107, 114, 128, 0.12)", fg: "#6b7280" },
	database: { bg: "rgba(168, 85, 247, 0.12)", fg: "#a855f7" },
	object: { bg: "rgba(14, 165, 233, 0.12)", fg: "#0ea5e9" },
	entry: { bg: "rgba(34, 197, 94, 0.12)", fg: "#22c55e" },
	other: { bg: "rgba(107, 114, 128, 0.08)", fg: "#9ca3af" },
};

function MiniIcon({ category }: { category: string }) {
	const props = {
		width: 12,
		height: 12,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 2,
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
	};
	switch (category) {
		case "folder":
			return (
				<svg {...props}>
					<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
				</svg>
			);
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
		case "database":
			return (
				<svg {...props}>
					<ellipse cx="12" cy="5" rx="9" ry="3" />
					<path d="M3 5V19A9 3 0 0 0 21 19V5" />
					<path d="M3 12A9 3 0 0 0 21 12" />
				</svg>
			);
		case "object":
			return (
				<svg {...props}>
					<rect x="3" y="3" width="7" height="7" rx="1" />
					<rect x="14" y="3" width="7" height="7" rx="1" />
					<rect x="3" y="14" width="7" height="7" rx="1" />
					<rect x="14" y="14" width="7" height="7" rx="1" />
				</svg>
			);
		case "entry":
			return (
				<svg {...props}>
					<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
					<circle cx="9" cy="7" r="4" />
					<path d="M22 21v-2a4 4 0 0 0-3-3.87" />
					<path d="M16 3.13a4 4 0 0 1 0 7.75" />
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

function shortenPath(path: string): string {
	return path
		.replace(/^\/Users\/[^/]+/, "~")
		.replace(/^\/home\/[^/]+/, "~")
		.replace(/^[A-Z]:\\Users\\[^\\]+/, "~");
}

// ── List component ──

const FileMentionList = forwardRef<FileMentionListRef, FileMentionListProps>(
	({ items, command, loading }, ref) => {
		const [selectedIndex, setSelectedIndex] = useState(0);
		const listRef = useRef<HTMLDivElement>(null);

		useEffect(() => {
			setSelectedIndex(0);
		}, [items]);

		useEffect(() => {
			const el = listRef.current?.children[selectedIndex] as
				| HTMLElement
				| undefined;
			el?.scrollIntoView({ block: "nearest" });
		}, [selectedIndex]);

		const selectItem = useCallback(
			(index: number) => {
				const item = items[index];
				if (item) {command(item);}
			},
			[items, command],
		);

		useImperativeHandle(ref, () => ({
			onKeyDown: ({ event }: { event: KeyboardEvent }) => {
				if (event.key === "ArrowUp") {
					setSelectedIndex((i) => (i + items.length - 1) % items.length);
					return true;
				}
				if (event.key === "ArrowDown") {
					setSelectedIndex((i) => (i + 1) % items.length);
					return true;
				}
				if (event.key === "Enter" || event.key === "Tab") {
					selectItem(selectedIndex);
					return true;
				}
				return false;
			},
		}));

		if (loading) {
			return (
				<div
					className="rounded-xl py-3 px-4 shadow-xl"
					style={{
						background: "var(--color-surface)",
						border: "1px solid var(--color-border)",
						backdropFilter: "blur(12px)",
						minWidth: 260,
					}}
				>
					<div className="flex items-center gap-2">
						<div
							className="w-3.5 h-3.5 border-2 rounded-full animate-spin"
							style={{
								borderColor: "var(--color-border)",
								borderTopColor: "var(--color-accent)",
							}}
						/>
						<span
							className="text-[12px]"
							style={{ color: "var(--color-text-muted)" }}
						>
						Searching...
					</span>
					</div>
				</div>
			);
		}

		if (items.length === 0) {
			return (
				<div
					className="rounded-xl py-3 px-4 shadow-xl"
					style={{
						background: "var(--color-surface)",
						border: "1px solid var(--color-border)",
						backdropFilter: "blur(12px)",
						minWidth: 260,
					}}
				>
					<span
						className="text-[12px]"
						style={{ color: "var(--color-text-muted)" }}
					>
						No results found
					</span>
				</div>
			);
		}

		return (
			<div
				ref={listRef}
				className="rounded-xl py-1 shadow-xl overflow-y-auto"
				style={{
					background: "var(--color-surface)",
					border: "1px solid var(--color-border)",
					backdropFilter: "blur(12px)",
					minWidth: 280,
					maxWidth: 400,
					maxHeight: 300,
				}}
			>
			{items.map((item, index) => {
				const category = getFileCategory(item.name, item.type);
				const colors = categoryColors[category] ?? categoryColors.other;
				const hasEmoji = item.icon && /\p{Emoji_Presentation}/u.test(item.icon);
				const isDbItem = item.type === "object" || item.type === "entry";
				const sublabel = item.type === "entry" && item.objectName
					? item.objectName
					: isDbItem
						? item.type
						: shortenPath(item.path);

				return (
					<button
						key={item.path}
						type="button"
						className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors"
						style={{
							background:
								index === selectedIndex
									? "var(--color-surface-hover)"
									: "transparent",
						}}
						onClick={() => selectItem(index)}
						onMouseEnter={() => setSelectedIndex(index)}
					>
						<div
							className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
							style={{ background: colors.bg, color: colors.fg }}
						>
							{hasEmoji ? (
								<span className="text-[13px] leading-none">{item.icon}</span>
							) : (
								<MiniIcon category={category} />
							)}
						</div>
						<div className="min-w-0 flex-1">
							<div
								className="text-[12px] font-medium truncate"
								style={{ color: "var(--color-text)" }}
							>
								{item.name}
							</div>
							<div
								className="text-[10px] truncate flex items-center gap-1"
								style={{ color: "var(--color-text-muted)" }}
								title={isDbItem ? sublabel : item.path}
							>
								{isDbItem && (
									<span
										className="inline-block rounded px-1 py-px text-[9px] font-medium leading-tight"
										style={{
											background: colors.bg,
											color: colors.fg,
										}}
									>
										{item.type}
									</span>
								)}
								{sublabel}
							</div>
						</div>
						{item.type === "folder" && (
							<svg
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								className="flex-shrink-0 opacity-40"
							>
								<path d="m9 18 6-6-6-6" />
							</svg>
						)}
					</button>
				);
			})}
			</div>
		);
	},
);

FileMentionList.displayName = "FileMentionList";

// ── Floating portal renderer for Tiptap suggestion ──

export type MentionRendererProps = {
	items: SuggestItem[];
	command: (item: SuggestItem) => void;
	clientRect: (() => DOMRect | null) | null | undefined;
	componentRef: React.RefObject<FileMentionListRef | null>;
	loading?: boolean;
};

export function MentionPopupRenderer({
	items,
	command,
	clientRect,
	componentRef,
	loading,
}: MentionRendererProps) {
	const popupRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		if (!popupRef.current || !clientRect) {return;}
		const rect = clientRect();
		if (!rect) {return;}

		const el = popupRef.current;
		const popupHeight = el.offsetHeight || 200;

		// Position above the cursor if not enough space below
		const spaceBelow = window.innerHeight - rect.bottom;
		if (spaceBelow < popupHeight + 8) {
			el.style.position = "fixed";
			el.style.left = `${rect.left}px`;
			el.style.bottom = `${window.innerHeight - rect.top + 4}px`;
			el.style.top = "auto";
		} else {
			el.style.position = "fixed";
			el.style.left = `${rect.left}px`;
			el.style.top = `${rect.bottom + 4}px`;
			el.style.bottom = "auto";
		}
		el.style.zIndex = "100";
	}, [clientRect, items, loading]);

	return createPortal(
		<div ref={popupRef}>
			<FileMentionList
				ref={componentRef}
				items={items}
				command={command}
				loading={loading}
			/>
		</div>,
		document.body,
	);
}

/**
 * Creates a Tiptap suggestion render() function that fetches file suggestions
 * from /api/workspace/suggest-files and renders them in a floating popup.
 */
export function createFileMentionRenderer() {
	return () => {
		let container: HTMLDivElement | null = null;
		let root: ReturnType<typeof import("react-dom/client").createRoot> | null =
			null;
		const componentRef: React.RefObject<FileMentionListRef | null> = {
			current: null,
		};
		let currentQuery = "";
		let currentItems: SuggestItem[] = [];
		let isLoading = false;
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		let latestCommand: ((item: SuggestItem) => void) | null = null;
		let latestClientRect: (() => DOMRect | null) | null = null;

		function render() {
			if (!root || !latestCommand) {return;}
			root.render(
				<MentionPopupRenderer
					items={currentItems}
					command={latestCommand}
					clientRect={latestClientRect}
					componentRef={componentRef}
					loading={isLoading}
				/>,
			);
		}

		async function fetchSuggestions(query: string) {
			isLoading = true;
			render();

			try {
				const hasPath =
					query.startsWith("/") ||
					query.startsWith("~/") ||
					query.startsWith("../") ||
					query.startsWith("./") ||
					query.includes("/");
				const param = hasPath
					? `path=${encodeURIComponent(query)}`
					: query
						? `q=${encodeURIComponent(query)}`
						: "";
				const url = `/api/workspace/suggest-files${param ? `?${param}` : ""}`;
				const res = await fetch(url);
				const data = await res.json();
				currentItems = data.items ?? [];
			} catch {
				currentItems = [];
			}

			isLoading = false;
			render();
		}

		function debouncedFetch(query: string) {
			if (debounceTimer) {clearTimeout(debounceTimer);}
			debounceTimer = setTimeout(() => {
				fetchSuggestions(query);
			}, 120);
		}

		return {
			onStart: (props: {
				query: string;
				command: (item: SuggestItem) => void;
				clientRect?: (() => DOMRect | null) | null;
			}) => {
				container = document.createElement("div");
				document.body.appendChild(container);
				latestCommand = props.command;
				latestClientRect = props.clientRect ?? null;
				currentQuery = props.query;

				import("react-dom/client").then(({ createRoot }) => {
					root = createRoot(container!);
					debouncedFetch(currentQuery);
				});
			},

			onUpdate: (props: {
				query: string;
				command: (item: SuggestItem) => void;
				clientRect?: (() => DOMRect | null) | null;
			}) => {
				latestCommand = props.command;
				latestClientRect = props.clientRect ?? null;
				currentQuery = props.query;
				debouncedFetch(currentQuery);
			},

			onKeyDown: (props: { event: KeyboardEvent }) => {
				if (props.event.key === "Escape") {
					root?.unmount();
					container?.remove();
					container = null;
					root = null;
					return true;
				}
				return componentRef.current?.onKeyDown(props) ?? false;
			},

			onExit: () => {
				if (debounceTimer) {clearTimeout(debounceTimer);}
				root?.unmount();
				container?.remove();
				container = null;
				root = null;
			},
		};
	};
}

export type { SuggestItem };
