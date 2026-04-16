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
import type { SearchIndexItem } from "@/lib/search-index";
import {
	IconFolderFilled,
	IconFileFilled,
	IconDatabaseFilled,
	IconTableFilled,
	IconLayoutKanbanFilled,
	IconPhoto,
	IconVideo,
	IconMusic,
	IconFileTypePdf,
	IconCode,
	IconUserFilled,
} from "@tabler/icons-react";

// ── Types ──

type SuggestItem = {
	name: string;
	path: string;
	type: "folder" | "file" | "document" | "database" | "object" | "entry";
	icon?: string;
	objectName?: string;
	entryId?: string;
	defaultView?: "table" | "kanban";
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
			"toml", "sh", "bash", "sql", "swift", "kt",
		].includes(ext)
	)
		{return "code";}
	if (type === "document") {return "document";}
	return "other";
}


function MentionIcon({ category, defaultView }: { category: string; defaultView?: string }) {
	const s = { flexShrink: 0 } as const;
	switch (category) {
		case "folder": return <IconFolderFilled size={18} style={{ ...s, color: "#60a5fa" }} />;
		case "image": return <IconPhoto size={18} style={{ ...s, color: "#10b981" }} />;
		case "video": return <IconVideo size={18} style={{ ...s, color: "#8b5cf6" }} />;
		case "audio": return <IconMusic size={18} style={{ ...s, color: "#f59e0b" }} />;
		case "pdf": return <IconFileFilled size={18} style={{ ...s, color: "#ef4444" }} />;
		case "code": return <IconCode size={18} style={{ ...s, color: "#3b82f6" }} />;
		case "database": return <IconDatabaseFilled size={18} style={s} />;
		case "object": return defaultView === "kanban"
			? <IconLayoutKanbanFilled size={18} style={{ ...s, color: "#8b7cf6" }} />
			: <IconTableFilled size={18} style={{ ...s, color: "#42a97a" }} />;
		case "entry": return <IconUserFilled size={18} style={{ ...s, color: "#22c55e" }} />;
		case "document": return <IconFileFilled size={18} style={{ ...s, opacity: 0.7 }} />;
		default: return <IconFileFilled size={18} style={{ ...s, opacity: 0.7 }} />;
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

	const dropdownClass = "bg-neutral-100/[0.67] dark:bg-neutral-900/[0.67] border border-white dark:border-white/10 backdrop-blur-md shadow-[0_0_25px_0_rgba(0,0,0,0.16)]";

	if (loading) {
		return (
			<div className={`rounded-3xl p-3 ${dropdownClass}`} style={{ minWidth: 280, maxWidth: 400 }}>
				<span className="text-xs animate-pulse" style={{ color: "var(--color-text-muted)" }}>
					Searching...
				</span>
			</div>
		);
	}

	if (items.length === 0) {
		return (
			<div className={`rounded-3xl p-3 text-center ${dropdownClass}`} style={{ minWidth: 280, maxWidth: 400 }}>
				<span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
					No results found
				</span>
			</div>
		);
	}

	return (
		<div
			ref={listRef}
			className={`rounded-3xl p-1 overflow-y-auto thin-scrollbar ${dropdownClass}`}
			style={{ minWidth: 280, maxWidth: 400, maxHeight: 300 }}
		>
		{items.map((item, index) => {
			const category = getFileCategory(item.name, item.type);
			const hasEmoji = item.icon && /\p{Emoji_Presentation}/u.test(item.icon);
			const isDbItem = item.type === "object" || item.type === "entry";
			const sublabel = item.type === "entry" && item.objectName
				? item.objectName
				: isDbItem
					? (item.defaultView === "kanban" ? "Board" : "Table")
					: shortenPath(item.path);

			return (
				<button
					key={item.path}
					type="button"
					className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left transition-all rounded-2xl select-none ${index === selectedIndex ? "bg-neutral-400/15" : ""}`}
					style={{ color: "var(--color-text)" }}
					onClick={() => selectItem(index)}
					onMouseEnter={() => setSelectedIndex(index)}
				>
					<span className="flex-shrink-0 flex items-center" style={{ opacity: 0.55 }}>
						{hasEmoji ? (
							<span className="text-[15px] leading-none">{item.icon}</span>
						) : (
							<MentionIcon category={category} defaultView={item.defaultView} />
						)}
					</span>
					<div className="min-w-0 flex-1">
						<div className="text-sm font-medium truncate">
							{item.name}
						</div>
						<div
							className="text-xs truncate"
							style={{ color: "var(--color-text-muted)" }}
							title={isDbItem ? sublabel : item.path}
						>
							{sublabel}
						</div>
					</div>
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
 * Creates a Tiptap suggestion render() function that fetches file suggestions.
 * If searchFnRef is provided, uses client-side search for instant results.
 * Otherwise falls back to /api/workspace/suggest-files.
 */
export function createFileMentionRenderer(searchFnRef?: React.RefObject<((query: string, limit?: number) => import("@/lib/search-index").SearchIndexItem[]) | null>) {
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

		function indexItemToSuggest(item: SearchIndexItem): SuggestItem {
			const fullPath = item.path ?? item.id;
			const fileName = fullPath.split("/").pop() ?? item.label;
			return {
				name: item.kind === "object" || item.kind === "entry" ? item.label : fileName,
				path: fullPath,
				type: (item.kind === "entry" ? "entry" : item.kind === "object" ? "object" : item.nodeType ?? "file") as SuggestItem["type"],
				icon: item.icon,
				objectName: item.objectName,
				entryId: item.entryId,
				defaultView: item.defaultView,
			};
		}

		function searchInstant(query: string) {
			const fn = searchFnRef?.current;
			if (fn) {
				currentItems = fn(query, 20).map(indexItemToSuggest);
				isLoading = false;
				render();
				return true;
			}
			return false;
		}

		async function fetchSuggestions(query: string) {
			if (searchInstant(query)) return;

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
			if (searchInstant(query)) return;
			if (debounceTimer) {clearTimeout(debounceTimer);}
			debounceTimer = setTimeout(() => {
				void fetchSuggestions(query);
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

				void import("react-dom/client").then(({ createRoot }) => {
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
				const handled = componentRef.current?.onKeyDown(props) ?? false;
				if (handled) {
					// Stop the chat-editor's DOM keydown listener from
					// also firing and submitting the message. By the time
					// that listener runs, the suggestion command has already
					// executed and the plugin state is inactive, so the
					// `suggestState.active` guard would not catch it.
					props.event.stopImmediatePropagation();
				}
				return handled;
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
