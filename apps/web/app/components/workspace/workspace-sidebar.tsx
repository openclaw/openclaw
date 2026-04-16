"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
	Combobox,
	ComboboxInput,
	ComboboxContent,
	ComboboxList,
	ComboboxItem,
} from "../ui/combobox";
import {
	IconFolderFilled,
	IconFileFilled,
	IconDatabaseFilled,
} from "@tabler/icons-react";
import { GoTools } from "react-icons/go";
import { RiApps2AiLine } from "react-icons/ri";
import { useTheme } from "next-themes";
import { FileManagerTree, type TreeNode } from "./file-manager-tree";
import { ProfileSwitcher } from "./profile-switcher";
import { CreateWorkspaceDialog } from "./create-workspace-dialog";
import { UnicodeSpinner } from "../unicode-spinner";
import { type WebSession, type SidebarSubagentInfo, type SidebarGatewaySession, type SidebarChannelStatus } from "./chat-sessions-sidebar";
import type { SearchIndexItem } from "@/lib/search-index";

/** Shape returned by /api/workspace/suggest-files */
type SuggestItem = {
	name: string;
	path: string;
	type: "folder" | "file" | "document" | "database";
};

function indexItemToSuggestItem(item: SearchIndexItem): SuggestItem {
	const fullPath = item.path ?? item.id;
	const fileName = fullPath.split("/").pop() ?? item.label;
	return {
		name: item.kind === "object" ? item.label : fileName,
		path: fullPath,
		type: (item.nodeType ?? (item.kind === "object" ? "folder" : "file")) as SuggestItem["type"],
	};
}

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
  /** Navigate to a sidebar section (cloud, integrations, skills, cron). */
  onNavigate?: (target: "cloud" | "integrations" | "skills" | "cron") => void;
  /** Client-side search function from useSearchIndex for instant results. */
  searchFn?: (query: string, limit?: number) => SearchIndexItem[];
};

function HomeIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
			<polyline points="9 22 9 12 15 12 15 22" />
		</svg>
	);
}

function FolderOpenIcon() {
	return (
		<img src="/icons/folder-open.png" alt="" width={20} height={20} draggable={false} style={{ flexShrink: 0 }} />
	);
}

/** Extract the directory name from an absolute path for display. */
function dirDisplayName(dir: string): string {
	if (dir === "/") {return "/";}
	return dir.split("/").pop() || dir;
}

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

function SuggestTypeIcon({ type }: { type: string }) {
	switch (type) {
		case "folder": return <IconFolderFilled size={16} style={{ flexShrink: 0, color: "#60a5fa" }} />;
		case "document": return <IconFileFilled size={16} style={{ flexShrink: 0, opacity: 0.7 }} />;
		case "database": return <IconDatabaseFilled size={16} style={{ flexShrink: 0 }} />;
		default: return <IconFileFilled size={16} style={{ flexShrink: 0, opacity: 0.7 }} />;
	}
}

/* ─── File search (base-ui Combobox) ─── */

function FileSearch({ onSelect, searchFn }: { onSelect: (item: SuggestItem) => void; searchFn?: (query: string, limit?: number) => SearchIndexItem[] }) {
	const [results, setResults] = useState<SuggestItem[]>([]);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const justSelectedRef = useRef(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const anchorRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		return () => { if (timerRef.current) clearTimeout(timerRef.current); };
	}, []);

	const handleInputValueChange = useCallback((inputValue: string) => {
		if (justSelectedRef.current) {
			justSelectedRef.current = false;
			return;
		}
		setQuery(inputValue);
		if (!inputValue.trim()) {
			setResults([]);
			setOpen(false);
			return;
		}
		if (searchFn) {
			const hits = searchFn(inputValue.trim(), 20);
			setResults(hits.map(indexItemToSuggestItem));
			setOpen(true);
		} else {
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(async () => {
				try {
					const res = await fetch(`/api/workspace/suggest-files?q=${encodeURIComponent(inputValue.trim())}`);
					const data = await res.json();
					setResults(data.items ?? []);
					setOpen(true);
				} catch {
					setResults([]);
				}
			}, 150);
		}
	}, [searchFn]);

	return (
		<Combobox
			value={null}
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) setOpen(false);
			}}
			onValueChange={(val) => {
				if (val) {
					justSelectedRef.current = true;
					onSelect(val as SuggestItem);
					setOpen(false);
					setQuery("");
					setResults([]);
				}
			}}
			onInputValueChange={handleInputValueChange}
			filter={null}
			itemToStringLabel={() => ""}
		>
			<div ref={anchorRef} className="relative">
				<span
					className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none z-10"
					style={{ color: "var(--color-text-muted)" }}
				>
					<SearchIcon />
				</span>
				<ComboboxInput
					placeholder="Search"
					className="w-full pl-9 pr-10 py-1.5 rounded-xl text-sm outline-none transition-colors"
					style={{
						background: "var(--color-surface-hover)",
						color: "var(--color-text)",
					}}
				/>
			</div>
			<ComboboxContent anchor={anchorRef}>
				<ComboboxList>
					{results.map((item) => (
						<ComboboxItem key={item.path} value={item}>
							<span className="flex-shrink-0" style={{ color: "var(--color-text-muted)", opacity: 0.55 }}>
								<SuggestTypeIcon type={item.type} />
							</span>
							<div className="min-w-0 flex-1">
								<div className="truncate font-medium">{item.name}</div>
								<div className="truncate text-xs" style={{ color: "var(--color-text-muted)" }}>
									{item.path.split("/").slice(0, -1).join("/")}
								</div>
							</div>
						</ComboboxItem>
					))}
				</ComboboxList>
				{query.trim() && results.length === 0 && (
					<div className="py-3 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>
						No files found
					</div>
				)}
			</ComboboxContent>
		</Combobox>
	);
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
	onExternalDrop,
	mobile,
	onClose,
	showHidden,
	onToggleHidden,
	width: widthProp,
	onCollapse,
  activeWorkspace,
  onWorkspaceChanged,
  onNavigate,
  searchFn,
}: WorkspaceSidebarProps) {
	const isBrowsing = browseDir != null;
	const width = mobile ? "280px" : (widthProp ?? 260);
	const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);

	const sidebar = (
		<aside
			className={`flex flex-col h-screen shrink-0 ${mobile ? "drawer-left" : "border-r"}`}
			style={{
				width: typeof width === "number" ? `${width}px` : width,
				minWidth: typeof width === "number" ? `${width}px` : width,
				background: "var(--color-bg)",
				borderColor: "var(--color-border)",
			}}
		>
			{/* Header */}
			<div
				className="flex items-center gap-2 px-3 h-[52px] shrink-0"
			>
				{isBrowsing ? (
					<>
						<div className="flex-1 min-w-0 flex items-center gap-1.5">
							<span className="shrink-0" style={{ color: "var(--color-text-muted)" }}>
								<FolderOpenIcon />
							</span>
							<span
								className="text-[13px] font-semibold truncate"
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
								className="p-1.5 rounded-lg shrink-0 transition-colors"
								style={{ color: "var(--color-text-muted)" }}
								onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)"; }}
								onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
								title="Return to workspace"
							>
								<HomeIcon />
							</button>
						)}
					</>
				) : (
					<div className="flex-1 min-w-0">
						<ProfileSwitcher
							activeWorkspaceHint={activeWorkspace ?? null}
							onWorkspaceSwitch={() => { onWorkspaceChanged?.(); }}
							onWorkspaceDelete={() => { onWorkspaceChanged?.(); }}
							onCreateWorkspace={() => { setCreateWorkspaceOpen(true); }}
							trigger={({ onClick, activeWorkspace: workspaceName, switching }) => (
								<button
									type="button"
									onClick={onClick}
									disabled={switching}
									className="group/ws text-[13px] flex items-center gap-2 truncate w-full transition-colors font-semibold rounded-xl px-2 py-1.5"
									style={{ color: "var(--color-text)" }}
									onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)"; }}
									onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
									title="Switch workspace"
								>
									<span className="truncate">{orgName || "Workspace"}</span>
									<span className="flex-1" />
									<span className="px-2 py-0.5 rounded-lg text-[10px] leading-tight shrink-0 bg-stone-200 text-stone-600 dark:bg-stone-700 dark:text-stone-300">
										{workspaceName || "-"}
									</span>
									<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" style={{ color: "var(--color-text-muted)" }}>
										<path d="m6 9 6 6 6-6" />
									</svg>
								</button>
							)}
						/>
					</div>
				)}
				{onCollapse && (
					<button
						type="button"
						onClick={onCollapse}
						className="p-1.5 rounded-lg shrink-0 transition-colors"
						style={{ color: "var(--color-text-muted)" }}
						onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)"; }}
						onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
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
			<div className="px-3">
				<FileSearch onSelect={onFileSearchSelect} searchFn={searchFn} />
			</div>
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

		{onNavigate && (
			<div
				className="px-2 py-1.5 border-t space-y-0.5"
				style={{ borderColor: "var(--color-border)" }}
			>
				{([
					{ id: "cloud" as const, label: "Cloud", icon: (
						<svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
							<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
						</svg>
					)},
					{ id: "integrations" as const, label: "Integrations", icon: (
						<RiApps2AiLine className="h-4 w-4 shrink-0" aria-hidden />
					)},
					{ id: "skills" as const, label: "Skills", icon: (
						<GoTools className="h-4 w-4 shrink-0" aria-hidden />
					)},
					{ id: "cron" as const, label: "Cron", icon: (
						<svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
							<circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
						</svg>
					)},
				]).map((item) => (
					<button
						key={item.id}
						type="button"
						onClick={() => onNavigate(item.id)}
						className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-xl text-sm font-medium transition-colors"
						style={{ color: "var(--color-text-muted)" }}
						onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)"; (e.currentTarget as HTMLElement).style.color = "var(--color-text)"; }}
						onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.color = "var(--color-text-muted)"; }}
					>
						<span className="shrink-0">{item.icon}</span>
						{item.label}
					</button>
				))}
			</div>
		)}

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
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
