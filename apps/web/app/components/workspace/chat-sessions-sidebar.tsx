"use client";

import { useCallback, useMemo, useState } from "react";
import { UnicodeSpinner } from "../unicode-spinner";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";

export type WebSession = {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
};

export type SidebarSubagentInfo = {
	childSessionKey: string;
	runId: string;
	task: string;
	label?: string;
	parentSessionId: string;
	status?: "running" | "completed" | "error";
};

type ChatSessionsSidebarProps = {
	sessions: WebSession[];
	activeSessionId: string | null;
	/** Title of the currently active session (shown in the header). */
	activeSessionTitle?: string;
	/** Session IDs with an actively running agent stream. */
	streamingSessionIds?: Set<string>;
	/** Subagents spawned by chat sessions. */
	subagents?: SidebarSubagentInfo[];
	/** Currently selected subagent session key (if viewing a subagent). */
	activeSubagentKey?: string | null;
	onSelectSession: (sessionId: string) => void;
	onNewSession: () => void;
	/** Called when a subagent is selected in the sidebar. */
	onSelectSubagent?: (sessionKey: string) => void;
	/** When true, renders as a mobile overlay drawer instead of a static sidebar. */
	mobile?: boolean;
	/** Close the mobile drawer. */
	onClose?: () => void;
	/** Fixed width in px when not mobile (overrides default 260). */
	width?: number;
	/** Called when the user deletes a session from the sidebar menu. */
	onDeleteSession?: (sessionId: string) => void;
	/** Called when the user renames a session from the sidebar menu. */
	onRenameSession?: (sessionId: string, newTitle: string) => void;
	/** Called when the user stops an actively running parent session. */
	onStopSession?: (sessionId: string) => void;
	/** Called when the user stops an actively running subagent session. */
	onStopSubagent?: (sessionKey: string) => void;
	/** Called when the user clicks the collapse/hide sidebar button. */
	onCollapse?: () => void;
	/** When true, show a loader instead of empty state (e.g. initial sessions fetch). */
	loading?: boolean;
	/** When true, renders just the content without the aside wrapper (for embedding in another sidebar). */
	embedded?: boolean;
};

/** Format a timestamp into a human-readable relative time string. */
function timeAgo(ts: number): string {
	const now = Date.now();
	const diff = now - ts;
	const seconds = Math.floor(diff / 1000);
	if (seconds < 60) {return "just now";}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {return `${minutes}m ago`;}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {return `${hours}h ago`;}
	const days = Math.floor(hours / 24);
	if (days < 30) {return `${days}d ago`;}
	const months = Math.floor(days / 30);
	if (months < 12) {return `${months}mo ago`;}
	return `${Math.floor(months / 12)}y ago`;
}

function PlusIcon() {
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
			<path d="M5 12h14" />
			<path d="M12 5v14" />
		</svg>
	);
}

function SubagentIcon() {
	return (
		<svg
			width="11"
			height="11"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M16 3h5v5" />
			<path d="m21 3-7 7" />
			<path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
		</svg>
	);
}

function ChatBubbleIcon() {
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
			<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
		</svg>
	);
}

function MoreHorizontalIcon() {
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
			<circle cx="12" cy="12" r="1" />
			<circle cx="5" cy="12" r="1" />
			<circle cx="19" cy="12" r="1" />
		</svg>
	);
}

function StopIcon() {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
		>
			<rect x="6" y="6" width="12" height="12" rx="2" />
		</svg>
	);
}

export function ChatSessionsSidebar({
	sessions,
	activeSessionId,
	activeSessionTitle: _activeSessionTitle,
	streamingSessionIds,
	subagents,
	activeSubagentKey,
	onSelectSession,
	onNewSession,
	onSelectSubagent,
	onDeleteSession,
	onRenameSession,
	onStopSession,
	onStopSubagent,
	onCollapse,
	mobile,
	onClose,
	width: widthProp,
	loading = false,
	embedded = false,
}: ChatSessionsSidebarProps) {
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");

	const handleSelect = useCallback(
		(id: string) => {
			onSelectSession(id);
			onClose?.();
		},
		[onSelectSession, onClose],
	);

	const handleSelectSubagentItem = useCallback(
		(sessionKey: string) => {
			onSelectSubagent?.(sessionKey);
			onClose?.();
		},
		[onSelectSubagent, onClose],
	);

	const handleDeleteSession = useCallback(
		(sessionId: string) => {
			onDeleteSession?.(sessionId);
		},
		[onDeleteSession],
	);

	const handleStartRename = useCallback((sessionId: string, currentTitle: string) => {
		setRenamingId(sessionId);
		setRenameValue(currentTitle || "");
	}, []);

	const handleCommitRename = useCallback(() => {
		if (renamingId && renameValue.trim()) {
			onRenameSession?.(renamingId, renameValue.trim());
		}
		setRenamingId(null);
		setRenameValue("");
	}, [renamingId, renameValue, onRenameSession]);

	// Index subagents by parent session ID
	const subagentsByParent = useMemo(() => {
		const map = new Map<string, SidebarSubagentInfo[]>();
		if (!subagents) {return map;}
		for (const sa of subagents) {
			let list = map.get(sa.parentSessionId);
			if (!list) {
				list = [];
				map.set(sa.parentSessionId, list);
			}
			list.push(sa);
		}
		return map;
	}, [subagents]);

	const filteredSessions = useMemo(
		() => sessions.filter((s) => !s.id.includes(":subagent:")),
		[sessions],
	);

	// Group sessions: today, yesterday, this week, this month, older
	const grouped = groupSessions(filteredSessions);

	const width = mobile ? "280px" : (widthProp ?? 260);
	const headerHeight = embedded ? 36 : 40;
	const content = (
		<div className="flex-1 min-h-0 relative">
			<div
				className="absolute inset-0 overflow-y-auto"
				style={{ paddingTop: headerHeight }}
			>
				{loading && sessions.length === 0 ? (
					<div className="px-4 py-8 flex flex-col items-center justify-center min-h-[120px]">
						<UnicodeSpinner
							name="braille"
							className="text-xl mb-2"
							style={{ color: "var(--color-text-muted)" }}
						/>
						<p
							className="text-xs"
							style={{ color: "var(--color-text-muted)" }}
						>
							Loading…
						</p>
					</div>
				) : sessions.length === 0 ? (
					<div className="px-4 py-8 text-center">
						<div
							className="mx-auto w-10 h-10 rounded-xl flex items-center justify-center mb-3"
							style={{
								background: "var(--color-surface-hover)",
								color: "var(--color-text-muted)",
							}}
						>
							<ChatBubbleIcon />
						</div>
						<p
							className="text-xs"
							style={{ color: "var(--color-text-muted)" }}
						>
							No conversations yet.
							<br />
							Start a new chat to begin.
						</p>
					</div>
				) : (
					<div className="px-2 py-1">
						{grouped.map((group) => (
							<div key={group.label}>
								<div
									className="px-2 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider"
									style={{ color: "var(--color-text-muted)" }}
								>
									{group.label}
								</div>
							{group.sessions.map((session) => {
								const isActive = session.id === activeSessionId && !activeSubagentKey;
								const isHovered = session.id === hoveredId;
								const isStreamingSession = streamingSessionIds?.has(session.id) ?? false;
								const showMore = isHovered || isStreamingSession;
								const sessionSubagents = subagentsByParent.get(session.id);
								return (
									<div
										key={session.id}
										className="group relative"
										onMouseEnter={() => setHoveredId(session.id)}
										onMouseLeave={() => setHoveredId(null)}
									>
									<div
										className="flex items-stretch w-full rounded-lg"
										style={{
											background: isActive
												? "var(--color-chat-sidebar-active-bg)"
												: isHovered
													? "var(--color-surface-hover)"
													: "transparent",
										}}
									>
										{renamingId === session.id ? (
											<form
												className="flex-1 min-w-0 px-2 py-1.5"
												onSubmit={(e) => { e.preventDefault(); handleCommitRename(); }}
											>
												<input
													type="text"
													value={renameValue}
													onChange={(e) => setRenameValue(e.target.value)}
													onBlur={handleCommitRename}
													onKeyDown={(e) => { if (e.key === "Escape") { setRenamingId(null); setRenameValue(""); } }}
													autoFocus
													className="w-full text-xs font-medium px-1 py-0.5 rounded outline-none border"
													style={{ color: "var(--color-text)", background: "var(--color-surface)", borderColor: "var(--color-border)" }}
												/>
											</form>
										) : (
										<button
											type="button"
											onClick={() => handleSelect(session.id)}
											className="flex-1 min-w-0 text-left px-2 py-2 rounded-l-lg transition-colors cursor-pointer"
										>
											<div className="flex items-center gap-1.5">
												{isStreamingSession && (
													<UnicodeSpinner
														name="braille"
														className="text-[10px] flex-shrink-0"
														style={{ color: "var(--color-chat-sidebar-muted)" }}
													/>
												)}
												<div
													className="text-xs font-medium truncate"
													style={{
														color: isActive
															? "var(--color-chat-sidebar-active-text)"
															: "var(--color-text)",
													}}
												>
													{session.title || "Untitled chat"}
												</div>
											</div>
											<div className="flex items-center gap-2 mt-0.5" style={{ paddingLeft: isStreamingSession ? "calc(0.375rem + 6px)" : undefined }}>

												<span
													className="text-[10px]"
													style={{ color: "var(--color-text-muted)" }}
												>
													{timeAgo(session.updatedAt)}
												</span>
												{session.messageCount > 0 && (
													<span
														className="text-[10px]"
														style={{ color: "var(--color-text-muted)" }}
													>
														{session.messageCount} msg{session.messageCount !== 1 ? "s" : ""}
													</span>
												)}
											</div>
										</button>
										)}
										<div className={`shrink-0 flex items-center pr-1 gap-0.5 transition-opacity ${showMore ? "opacity-100" : "opacity-0"}`}>
											{isStreamingSession && onStopSession && (
												<button
													type="button"
													onClick={(e) => {
														e.stopPropagation();
														onStopSession(session.id);
													}}
													className="flex items-center justify-center w-6 h-6 rounded-md transition-colors hover:bg-black/5"
													style={{ color: "var(--color-text-muted)" }}
													title="Stop chat"
													aria-label="Stop chat"
												>
													<StopIcon />
												</button>
											)}
											{onDeleteSession && (
												<DropdownMenu>
													<DropdownMenuTrigger
														onClick={(e) => e.stopPropagation()}
														className="flex items-center justify-center w-6 h-6 rounded-md"
														style={{ color: "var(--color-text-muted)" }}
														title="More options"
														aria-label="More options"
													>
														<MoreHorizontalIcon />
													</DropdownMenuTrigger>
													<DropdownMenuContent align="end" side="bottom">
														<DropdownMenuItem
															onSelect={() => handleStartRename(session.id, session.title)}
														>
															<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /></svg>
															Rename
														</DropdownMenuItem>
														<DropdownMenuItem
															variant="destructive"
															onSelect={() => handleDeleteSession(session.id)}
														>
															<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>
															Delete
														</DropdownMenuItem>
													</DropdownMenuContent>
												</DropdownMenu>
											)}
										</div>
									</div>
									{/* Subagent sub-items */}
									{sessionSubagents && sessionSubagents.length > 0 && (
										<div className="ml-4 border-l" style={{ borderColor: "var(--color-border)" }}>
											{sessionSubagents.map((sa) => {
												const isSubActive = activeSubagentKey === sa.childSessionKey;
												const isSubRunning = sa.status === "running";
												const subLabel = sa.label || sa.task;
												const truncated = subLabel.length > 40 ? subLabel.slice(0, 40) + "..." : subLabel;
												return (
													<div
														key={sa.childSessionKey}
														className="flex items-center"
													>
														<button
															type="button"
															onClick={() => handleSelectSubagentItem(sa.childSessionKey)}
															className="flex-1 text-left pl-3 pr-2 py-1.5 rounded-r-lg transition-colors cursor-pointer"
															style={{
																background: isSubActive
																	? "var(--color-chat-sidebar-active-bg)"
																	: "transparent",
															}}
														>
															<div className="flex items-center gap-1.5">
																{isSubRunning && (
																	<UnicodeSpinner
																		name="braille"
																		className="text-[9px] flex-shrink-0"
																		style={{ color: "var(--color-chat-sidebar-muted)" }}
																	/>
																)}
																<SubagentIcon />
																<span
																	className="text-[11px] truncate"
																	style={{
																		color: isSubActive
																			? "var(--color-chat-sidebar-active-text)"
																			: "var(--color-text-muted)",
																	}}
																>
																	{truncated}
																</span>
															</div>
														</button>
														{isSubRunning && onStopSubagent && (
															<button
																type="button"
																onClick={(e) => {
																	e.stopPropagation();
																	onStopSubagent(sa.childSessionKey);
																}}
																className="shrink-0 flex items-center justify-center w-6 h-6 rounded-md mr-1 transition-colors hover:bg-black/5"
																style={{ color: "var(--color-text-muted)" }}
																title="Stop subagent"
																aria-label="Stop subagent"
															>
																<StopIcon />
															</button>
														)}
													</div>
												);
											})}
										</div>
									)}
									</div>
									);
								})}
							</div>
						))}
					</div>
				)}
			</div>
			{/* Header overlay: backdrop blur + 80% bg; list scrolls under it */}
			<div
				className={`absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 backdrop-blur-md ${embedded ? "" : "border-b"}`}
				style={{
					height: headerHeight,
					borderColor: embedded ? undefined : "var(--color-border)",
					background: "var(--color-sidebar-bg)",
					boxShadow: embedded ? "inset 0 -1px 0 0 var(--color-border)" : undefined,
				}}
			>
				<div className="min-w-0 flex-1 flex items-center gap-1.5">
					{onCollapse && (
						<button
							type="button"
							onClick={onCollapse}
							className="p-1 rounded-md shrink-0 transition-colors hover:bg-black/5"
							style={{ color: "var(--color-text-muted)" }}
							title="Hide chat sidebar (⌘⇧B)"
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<rect width="18" height="18" x="3" y="3" rx="2" />
								<path d="M15 3v18" />
							</svg>
						</button>
					)}
					<span
						className="text-xs font-medium truncate block"
						style={{ color: "var(--color-text)" }}
					>
						Chats
					</span>
				</div>
				<button
					type="button"
					onClick={onNewSession}
					className={`flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium transition-all cursor-pointer shrink-0 ml-1.5 ${embedded ? "hover:bg-neutral-400/15" : ""}`}
					style={{
						color: embedded ? "var(--color-text)" : "var(--color-chat-sidebar-active-text)",
						background: embedded ? "transparent" : "var(--color-chat-sidebar-active-bg)",
					}}
					title="New chat"
				>
					<PlusIcon />
					New
				</button>
			</div>
		</div>
	);

	if (embedded) {
		return content;
	}

	const sidebar = (
		<aside
			className={`flex flex-col h-full shrink-0 ${mobile ? "drawer-right" : "border-l"}`}
			style={{
				width: typeof width === "number" ? `${width}px` : width,
				minWidth: typeof width === "number" ? `${width}px` : width,
				borderColor: "var(--color-border)",
				background: "var(--color-sidebar-bg)",
			}}
		>
			{content}
		</aside>
	);

    if (!mobile) { return sidebar; }

	return (
		<div className="drawer-backdrop" onClick={() => void onClose?.()}>
			{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
			<div onClick={(e) => e.stopPropagation()} className="fixed inset-y-0 right-0 z-50">
				{sidebar}
			</div>
		</div>
	);
}

// ── Grouping helpers ──

type SessionGroup = {
	label: string;
	sessions: WebSession[];
};

function groupSessions(sessions: WebSession[]): SessionGroup[] {
	const now = new Date();
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const yesterdayStart = todayStart - 86400000;
	const weekStart = todayStart - 7 * 86400000;
	const monthStart = todayStart - 30 * 86400000;

	const today: WebSession[] = [];
	const yesterday: WebSession[] = [];
	const thisWeek: WebSession[] = [];
	const thisMonth: WebSession[] = [];
	const older: WebSession[] = [];

	for (const s of sessions) {
		const t = s.updatedAt;
		if (t >= todayStart) {today.push(s);}
		else if (t >= yesterdayStart) {yesterday.push(s);}
		else if (t >= weekStart) {thisWeek.push(s);}
		else if (t >= monthStart) {thisMonth.push(s);}
		else {older.push(s);}
	}

	const groups: SessionGroup[] = [];
	if (today.length > 0) {groups.push({ label: "Today", sessions: today });}
	if (yesterday.length > 0) {groups.push({ label: "Yesterday", sessions: yesterday });}
	if (thisWeek.length > 0) {groups.push({ label: "This Week", sessions: thisWeek });}
	if (thisMonth.length > 0) {groups.push({ label: "This Month", sessions: thisMonth });}
	if (older.length > 0) {groups.push({ label: "Older", sessions: older });}
	return groups;
}
