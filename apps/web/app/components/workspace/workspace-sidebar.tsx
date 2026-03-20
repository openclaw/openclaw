"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useTheme } from "next-themes";
import { FileManagerTree, type TreeNode } from "./file-manager-tree";
import { ProfileSwitcher } from "./profile-switcher";
import { CreateWorkspaceDialog } from "./create-workspace-dialog";
import { UnicodeSpinner } from "../unicode-spinner";
import { ChatSessionsSidebar, type WebSession, type SidebarSubagentInfo, type SidebarGatewaySession, type SidebarChannelStatus } from "./chat-sessions-sidebar";

/** Shape returned by /api/workspace/suggest-files */
type SuggestItem = {
	name: string;
	path: string;
	type: "folder" | "file" | "document" | "database";
};

type WorkspaceSidebarProps = {
	tree: TreeNode[];
	activePath: string | null;
	onSelect: (node: TreeNode) => void;
	onRefresh: () => void;
	orgName?: string;
	loading?: boolean;
	/** Current browse directory (absolute path), or null when in workspace mode. */
	browseDir?: string | null;
	/** Parent directory for ".." navigation. Null at filesystem root or when browsing is unavailable. */
	parentDir?: string | null;
	/** Navigate up one directory. */
	onNavigateUp?: () => void;
	/** Return to workspace mode from browse mode. */
	onGoHome?: () => void;
	/** Called when a file/folder is selected from the search dropdown. */
	onFileSearchSelect?: (item: SuggestItem) => void;
	/** Absolute path of the workspace root folder, used to render it as a special entry in browse mode. */
	workspaceRoot?: string | null;
	/** Navigate to the main chat / home panel. */
	onGoToChat?: () => void;
	/** Called when a tree node is dragged and dropped onto an external target (e.g. chat input). */
	onExternalDrop?: (node: TreeNode) => void;
	/** When true, renders as a mobile overlay drawer instead of a static sidebar. */
	mobile?: boolean;
	/** Close the mobile drawer. */
	onClose?: () => void;
	/** Fixed width in px when not mobile (overrides default 260). */
	width?: number;
	/** Whether hidden (dot) files/folders are currently shown. */
	showHidden?: boolean;
	/** Toggle hidden files visibility. */
	onToggleHidden?: () => void;
	/** Called when the user clicks the collapse/hide sidebar button. */
	onCollapse?: () => void;
  /** Active workspace hint used by the switcher. */
  activeWorkspace?: string | null;
  /** Called after workspace switches or workspace creation so parent can refresh state. */
  onWorkspaceChanged?: () => void;
  /** Chat sessions for the Chats tab. */
  chatSessions?: WebSession[];
  activeChatSessionId?: string | null;
  activeChatSessionTitle?: string;
  chatStreamingSessionIds?: Set<string>;
  chatSubagents?: SidebarSubagentInfo[];
  chatActiveSubagentKey?: string | null;
  chatSessionsLoading?: boolean;
  onSelectChatSession?: (sessionId: string) => void;
  onNewChatSession?: () => void;
  onSelectChatSubagent?: (sessionKey: string) => void;
  onDeleteChatSession?: (sessionId: string) => void;
  onRenameChatSession?: (sessionId: string, newTitle: string) => void;
  chatGatewaySessions?: SidebarGatewaySession[];
  chatChannelStatuses?: SidebarChannelStatus[];
  chatActiveGatewaySessionKey?: string | null;
  onSelectGatewayChatSession?: (sessionKey: string, sessionId: string) => void;
  chatFileScopedSessions?: WebSession[];
  chatHeartbeatInfo?: { intervalMs: number; nextDueEstimateMs: number | null } | null;
  /** Which tab is active. Controlled from parent if provided. */
  activeTab?: "files" | "chats";
  onTabChange?: (tab: "files" | "chats") => void;
};

function HomeIcon() {
	return (
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
			<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
			<polyline points="9 22 9 12 15 12 15 22" />
		</svg>
	);
}

function FolderOpenIcon() {
	return (
		<img
			src="/icons/folder-open.png"
			alt=""
			width={20}
			height={20}
			draggable={false}
			style={{ flexShrink: 0 }}
		/>
	);
}

/* ─── Theme toggle ─── */

function ThemeToggle() {
	const { resolvedTheme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);

	if (!mounted) return <div className="w-[28px] h-[28px]" />;

	const isDark = resolvedTheme === "dark";

	return (
		<button
			type="button"
			onClick={() => setTheme(isDark ? "light" : "dark")}
			className="p-1.5 rounded-lg"
			style={{ color: "var(--color-text-muted)" }}
			title={isDark ? "Switch to light mode" : "Switch to dark mode"}
		>
			{isDark ? (
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
					<circle cx="12" cy="12" r="4" />
					<path d="M12 2v2" /><path d="M12 20v2" />
					<path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" />
					<path d="M2 12h2" /><path d="M20 12h2" />
					<path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
				</svg>
			) : (
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
					<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
				</svg>
			)}
		</button>
	);
}

function SearchIcon() {
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
			<circle cx="11" cy="11" r="8" />
			<path d="m21 21-4.3-4.3" />
		</svg>
	);
}

function SmallFolderIcon() {
	return (
		<img
			src="/icons/folder.png"
			alt=""
			width={14}
			height={14}
			draggable={false}
			style={{ flexShrink: 0 }}
		/>
	);
}

function SmallFileIcon() {
	return (
		<img src="/icons/document.png" alt="" width={14} height={14} draggable={false} style={{ flexShrink: 0, filter: "drop-shadow(0 0.5px 1.5px rgba(0,0,0,0.2))" }} />
	);
}

function SmallDocIcon() {
	return (
		<img src="/icons/document.png" alt="" width={14} height={14} draggable={false} style={{ flexShrink: 0, filter: "drop-shadow(0 0.5px 1.5px rgba(0,0,0,0.2))" }} />
	);
}

function SmallDbIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5V19A9 3 0 0 0 21 19V5" /><path d="M3 12A9 3 0 0 0 21 12" />
		</svg>
	);
}

function SuggestTypeIcon({ type }: { type: string }) {
	switch (type) {
		case "folder": return <SmallFolderIcon />;
		case "document": return <SmallDocIcon />;
		case "database": return <SmallDbIcon />;
		default: return <SmallFileIcon />;
	}
}

/* ─── File search ─── */

function FileSearch({ onSelect }: { onSelect: (item: SuggestItem) => void }) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<SuggestItem[]>([]);
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	// Debounced fetch from the same suggest-files API that tiptap uses
	useEffect(() => {
		if (!query.trim()) {
			setResults([]);
			setOpen(false);
			return;
		}

		setLoading(true);
		const timer = setTimeout(async () => {
			try {
				const res = await fetch(
					`/api/workspace/suggest-files?q=${encodeURIComponent(query.trim())}`,
				);
				const data = await res.json();
				setResults(data.items ?? []);
				setOpen(true);
				setSelectedIndex(0);
			} catch {
				setResults([]);
			} finally {
				setLoading(false);
			}
		}, 150);

		return () => clearTimeout(timer);
	}, [query]);

	// Click outside to close
	useEffect(() => {
		function handleClickOutside(e: MouseEvent) {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, []);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((i) => Math.max(i - 1, 0));
			} else if (e.key === "Enter" && results[selectedIndex]) {
				e.preventDefault();
				onSelect(results[selectedIndex]);
				setQuery("");
				setOpen(false);
				inputRef.current?.blur();
			} else if (e.key === "Escape") {
				setOpen(false);
				setQuery("");
				inputRef.current?.blur();
			}
		},
		[results, selectedIndex, onSelect],
	);

	const handleSelect = useCallback(
		(item: SuggestItem) => {
			onSelect(item);
			setQuery("");
			setOpen(false);
		},
		[onSelect],
	);

	return (
		<div ref={containerRef} className="relative px-3 pt-2 pb-1">
			<div className="relative">
				<span
					className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
					style={{ color: "var(--color-text-muted)" }}
				>
					<SearchIcon />
				</span>
				<input
					ref={inputRef}
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={handleKeyDown}
					onFocus={() => { if (results.length > 0) {setOpen(true);} }}
					placeholder="Search files..."
					className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs outline-none transition-colors"
					style={{
						background: "var(--color-bg)",
						color: "var(--color-text)",
						border: "1px solid var(--color-border)",
					}}
				/>
				{loading && (
					<span className="absolute right-2.5 top-1/2 -translate-y-1/2">
						<UnicodeSpinner
							name="braille"
							className="text-sm"
							style={{ color: "var(--color-text-muted)" }}
						/>
					</span>
				)}
			</div>

			{open && results.length > 0 && (
				<div
					className="absolute left-3 right-3 mt-1 rounded-lg shadow-lg border overflow-hidden z-50 max-h-[300px] overflow-y-auto"
					style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
				>
					{results.map((item, i) => (
						<button
							key={item.path}
							type="button"
							onClick={() => handleSelect(item)}
							className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs cursor-pointer transition-colors"
							style={{
								background: i === selectedIndex ? "var(--color-surface-hover)" : "transparent",
								color: "var(--color-text)",
							}}
							onMouseEnter={() => setSelectedIndex(i)}
						>
							<span className="flex-shrink-0" style={{ color: "var(--color-text-muted)" }}>
								<SuggestTypeIcon type={item.type} />
							</span>
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium">{item.name}</div>
								<div className="truncate" style={{ color: "var(--color-text-muted)", fontSize: "10px" }}>
									{item.path.split("/").slice(0, -1).join("/")}
								</div>
							</div>
							<span
								className="text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 capitalize"
								style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
							>
								{item.type}
							</span>
						</button>
					))}
				</div>
			)}

			{open && query.trim() && !loading && results.length === 0 && (
				<div
					className="absolute left-3 right-3 mt-1 rounded-lg shadow-lg border z-50 px-3 py-3 text-center"
					style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
				>
					<p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
						No files found
					</p>
				</div>
			)}
		</div>
	);
}

/** Extract the directory name from an absolute path for display. */
function dirDisplayName(dir: string): string {
	if (dir === "/") {return "/";}
	return dir.split("/").pop() || dir;
}

export function WorkspaceSidebar({
	tree,
	activePath,
	onSelect,
	onRefresh,
	orgName,
	loading,
	browseDir,
	parentDir,
	onNavigateUp,
	onGoHome,
	onFileSearchSelect,
	workspaceRoot,
	onGoToChat,
	onExternalDrop,
	mobile,
	onClose,
	showHidden,
	onToggleHidden,
	width: widthProp,
	onCollapse,
  activeWorkspace,
  onWorkspaceChanged,
  chatSessions,
  activeChatSessionId,
  activeChatSessionTitle,
  chatStreamingSessionIds,
  chatSubagents,
  chatActiveSubagentKey,
  chatSessionsLoading,
  onSelectChatSession,
  onNewChatSession,
  onSelectChatSubagent,
  onDeleteChatSession,
  onRenameChatSession,
  activeTab: activeTabProp,
  onTabChange,
}: WorkspaceSidebarProps) {
	const isBrowsing = browseDir != null;
	const width = mobile ? "280px" : (widthProp ?? 260);
	const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
	const hasChatProps = chatSessions !== undefined;
	const [internalTab, setInternalTab] = useState<"files" | "chats">(activeTabProp ?? "files");
	const currentTab = activeTabProp ?? internalTab;
	const setTab = useCallback((tab: "files" | "chats") => {
		setInternalTab(tab);
		onTabChange?.(tab);
	}, [onTabChange]);

	const sidebar = (
		<aside
			className={`flex flex-col h-screen shrink-0 ${mobile ? "drawer-left" : "border-r"}`}
			style={{
				width: typeof width === "number" ? `${width}px` : width,
				minWidth: typeof width === "number" ? `${width}px` : width,
				background: "var(--color-sidebar-bg)",
				borderColor: "var(--color-border)",
			}}
		>
			{/* Header */}
			<div
				className="flex items-center gap-2 px-3 h-[36px] border-b"
				style={{ borderColor: "var(--color-border)" }}
			>
				{isBrowsing ? (
					<>
						<div className="flex-1 min-w-0 flex items-center gap-1.5">
							<span
								className="shrink-0"
								style={{ color: "var(--color-text-muted)" }}
							>
								<FolderOpenIcon />
							</span>
							<span
								className="text-[12px] font-medium truncate"
								style={{ color: "var(--color-text)" }}
								title={browseDir}
							>
								{dirDisplayName(browseDir)}
							</span>
						</div>
						{onGoHome && (
							<button
								type="button"
								onClick={onGoHome}
								className="p-1 rounded-md shrink-0 transition-colors hover:bg-stone-200 dark:hover:bg-stone-700"
								style={{ color: "var(--color-text-muted)" }}
								title="Return to workspace"
							>
								<HomeIcon />
							</button>
						)}
					</>
				) : (
					<>
						<div className="flex-1 min-w-0">
							<ProfileSwitcher
								activeWorkspaceHint={activeWorkspace ?? null}
								onWorkspaceSwitch={() => {
									onWorkspaceChanged?.();
								}}
								onWorkspaceDelete={() => {
									onWorkspaceChanged?.();
								}}
								onCreateWorkspace={() => {
									setCreateWorkspaceOpen(true);
								}}
								trigger={({ onClick, activeWorkspace: workspaceName, switching }) => (
									<button
										type="button"
										onClick={onClick}
										disabled={switching}
										className="text-[12px] flex items-center gap-1.5 truncate w-full transition-colors font-medium rounded-md px-1.5 py-1 -mx-1.5 hover:bg-stone-200/60 dark:hover:bg-stone-700/60"
										style={{ color: "var(--color-text)" }}
										title="Switch workspace"
									>
										<span className="truncate">{orgName || "Workspace"}</span>
										<span className="px-1 py-px rounded text-[10px] leading-tight shrink-0 bg-stone-200 text-stone-600 dark:bg-stone-700 dark:text-stone-300">
											{workspaceName || "-"}
										</span>
										<svg
											width="10"
											height="10"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
											strokeLinejoin="round"
											className="shrink-0"
											style={{ color: "var(--color-text-muted)" }}
										>
											<path d="m6 9 6 6 6-6" />
										</svg>
									</button>
								)}
							/>
						</div>
					</>
				)}
				{onCollapse && (
					<button
						type="button"
						onClick={onCollapse}
						className="p-1 rounded-md shrink-0 transition-colors hover:bg-stone-200 dark:hover:bg-stone-700"
						style={{ color: "var(--color-text-muted)" }}
						title="Hide sidebar (⌘B)"
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<rect width="18" height="18" x="3" y="3" rx="2" />
							<path d="M9 3v18" />
						</svg>
					</button>
				)}
			</div>

			{onFileSearchSelect && (
				<FileSearch onSelect={onFileSearchSelect} />
			)}

			<div className="flex-1 overflow-y-auto px-1">
				{loading ? (
					<div className="flex items-center justify-center py-12">
						<UnicodeSpinner
							name="braille"
							className="text-2xl"
							style={{ color: "var(--color-text-muted)" }}
						/>
					</div>
				) : (
					<FileManagerTree
						tree={tree}
						activePath={activePath}
						onSelect={onSelect}
						onRefresh={onRefresh}
						parentDir={parentDir}
						onNavigateUp={onNavigateUp}
						browseDir={browseDir}
						workspaceRoot={workspaceRoot}
						onExternalDrop={onExternalDrop}
					/>
				)}
			</div>

			{/* Footer */}
			<div
				className="px-3 py-2.5 border-t flex items-center justify-between"
				style={{ borderColor: "var(--color-border)" }}
			>
				<a
					href="https://dench.com"
					target="_blank"
					rel="noopener noreferrer"
					className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm"
					style={{ color: "var(--color-text-muted)" }}
				>
					dench.com{process.env.NEXT_PUBLIC_DENCHCLAW_VERSION ? ` (v${process.env.NEXT_PUBLIC_DENCHCLAW_VERSION})` : ""}
				</a>
				<div className="flex items-center gap-0.5">
					{onToggleHidden && (
						<button
							type="button"
							onClick={onToggleHidden}
							className="p-1.5 rounded-lg transition-colors"
							style={{ color: showHidden ? "var(--color-accent)" : "var(--color-text-muted)" }}
							title={showHidden ? "Hide dotfiles" : "Show dotfiles"}
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
								{showHidden ? (
									<>
										<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
										<circle cx="12" cy="12" r="3" />
									</>
								) : (
									<>
										<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
										<path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
										<path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
										<path d="m2 2 20 20" />
									</>
								)}
							</svg>
						</button>
					)}
					<ThemeToggle />
				</div>
			</div>
		</aside>
	);

	if (!mobile) {
		return (
			<>
				{sidebar}
				<CreateWorkspaceDialog
					isOpen={createWorkspaceOpen}
					onClose={() => setCreateWorkspaceOpen(false)}
					onCreated={() => {
						onWorkspaceChanged?.();
					}}
				/>
			</>
		);
	}

	return (
		<>
			<div className="drawer-backdrop" onClick={() => void onClose?.()}>
				{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
				<div onClick={(e) => e.stopPropagation()} className="fixed inset-y-0 left-0 z-50">
					{sidebar}
				</div>
			</div>
			<CreateWorkspaceDialog
				isOpen={createWorkspaceOpen}
				onClose={() => setCreateWorkspaceOpen(false)}
				onCreated={() => {
					onWorkspaceChanged?.();
				}}
			/>
		</>
	);
}
