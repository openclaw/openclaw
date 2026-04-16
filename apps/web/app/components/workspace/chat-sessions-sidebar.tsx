"use client";

import { useCallback, useMemo, useState } from "react";
import { UnicodeSpinner } from "../unicode-spinner";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
	ContextMenu,
	ContextMenuTrigger,
	ContextMenuContent,
	ContextMenuItem,
} from "../ui/context-menu";

export type WebSession = {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	filePath?: string;
};

export type SidebarSubagentInfo = {
	childSessionKey: string;
	runId: string;
	task: string;
	label?: string;
	parentSessionId: string;
	status?: "running" | "completed" | "error";
};

export type SidebarGatewaySession = {
	sessionKey: string;
	sessionId: string;
	channel: string;
	title: string;
	updatedAt: number;
	origin?: {
		label?: string;
		provider?: string;
	};
};

export type SidebarChannelStatus = {
	id: string;
	configured: boolean;
	running: boolean;
	connected: boolean;
	error?: string;
};

type SidebarTab = {
	id: string;
	label: string;
	icon?: () => React.JSX.Element;
	iconColor?: string;
	count?: number;
};

type ChatSessionsSidebarProps = {
	sessions: WebSession[];
	activeSessionId: string | null;
	activeSessionTitle?: string;
	streamingSessionIds?: Set<string>;
	subagents?: SidebarSubagentInfo[];
	activeSubagentKey?: string | null;
	onSelectSession: (sessionId: string) => void;
	onNewSession: () => void;
	onSelectSubagent?: (sessionKey: string) => void;
	mobile?: boolean;
	onClose?: () => void;
	width?: number;
	onDeleteSession?: (sessionId: string) => void;
	onRenameSession?: (sessionId: string, newTitle: string) => void;
	onStopSession?: (sessionId: string) => void;
	onStopSubagent?: (sessionKey: string) => void;
	onCollapse?: () => void;
	loading?: boolean;
	embedded?: boolean;
	gatewaySessions?: SidebarGatewaySession[];
	channelStatuses?: SidebarChannelStatus[];
	activeGatewaySessionKey?: string | null;
	onSelectGatewaySession?: (sessionKey: string, sessionId: string) => void;
	fileScopedSessions?: WebSession[];
	heartbeatInfo?: { intervalMs: number; nextDueEstimateMs: number | null } | null;
};

function timeAgo(ts: number): string {
	const now = Date.now();
	const diff = now - ts;
	const seconds = Math.floor(diff / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	return `${Math.floor(months / 12)}y ago`;
}

// ── Icon components ──

function PlusIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M5 12h14" /><path d="M12 5v14" />
		</svg>
	);
}

function SubagentIcon() {
	return (
		<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M16 3h5v5" /><path d="m21 3-7 7" /><path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
		</svg>
	);
}

function ChatBubbleIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
		</svg>
	);
}

function MoreHorizontalIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<circle cx="12" cy="12" r="1" /><circle cx="5" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
		</svg>
	);
}

function StopIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<rect x="6" y="6" width="12" height="12" rx="2" />
		</svg>
	);
}

function TelegramIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
			<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z" />
		</svg>
	);
}

function WhatsAppIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
			<path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
		</svg>
	);
}

function DiscordIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
			<path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
		</svg>
	);
}

function SlackIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
			<path d="M5.042 15.165a2.528 2.528 0 01-2.52 2.523A2.528 2.528 0 010 15.165a2.527 2.527 0 012.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 012.521-2.52 2.527 2.527 0 012.521 2.52v6.313A2.528 2.528 0 018.834 24a2.528 2.528 0 01-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 01-2.521-2.52A2.528 2.528 0 018.834 0a2.528 2.528 0 012.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 012.521 2.521 2.528 2.528 0 01-2.521 2.521H2.522A2.528 2.528 0 010 8.834a2.528 2.528 0 012.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 012.522-2.521A2.528 2.528 0 0124 8.834a2.528 2.528 0 01-2.522 2.521h-2.522V8.834zm-1.27 0a2.528 2.528 0 01-2.523 2.521 2.527 2.527 0 01-2.52-2.521V2.522A2.527 2.527 0 0115.163 0a2.528 2.528 0 012.523 2.522v6.312zM15.163 18.956a2.528 2.528 0 012.523 2.522A2.528 2.528 0 0115.163 24a2.527 2.527 0 01-2.52-2.522v-2.522h2.52zm0-1.27a2.527 2.527 0 01-2.52-2.523 2.527 2.527 0 012.52-2.52h6.315A2.528 2.528 0 0124 15.163a2.528 2.528 0 01-2.522 2.523h-6.315z" />
		</svg>
	);
}

function SignalIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
			<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h-2v-6h2v6zm4 0h-2v-6h2v6zm-2-8a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm-4 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" />
		</svg>
	);
}

function IMessageIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
			<path d="M12 2C6.477 2 2 5.813 2 10.5c0 2.684 1.464 5.084 3.768 6.635L4.5 21l4.17-2.083A11.51 11.51 0 0012 19.5c5.523 0 10-3.813 10-8.5S17.523 2 12 2z" />
		</svg>
	);
}

function CronIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
		</svg>
	);
}

function HeartbeatIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M22 12h-4l-3 9L9 3l-3 9H2" />
		</svg>
	);
}

function FileIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" />
		</svg>
	);
}

function GoogleChatIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
			<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10h5v-2h-5a8 8 0 110-16 8 8 0 018 8v1.43c0 .79-.71 1.57-1.5 1.57s-1.5-.78-1.5-1.57V12a5 5 0 10-1.47 3.53 3.5 3.5 0 002.97 1.47c1.93 0 3.5-1.57 3.5-3.57V12c0-5.52-4.48-10-10-10zm0 13a3 3 0 110-6 3 3 0 010 6z" />
		</svg>
	);
}

function NostrIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
			<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
		</svg>
	);
}

const CHANNEL_META: Record<string, { label: string; icon: () => React.JSX.Element; color: string }> = {
	telegram: { label: "Telegram", icon: TelegramIcon, color: "#2AABEE" },
	whatsapp: { label: "WhatsApp", icon: WhatsAppIcon, color: "#25D366" },
	discord: { label: "Discord", icon: DiscordIcon, color: "#5865F2" },
	slack: { label: "Slack", icon: SlackIcon, color: "#4A154B" },
	signal: { label: "Signal", icon: SignalIcon, color: "#3A76F0" },
	imessage: { label: "iMessage", icon: IMessageIcon, color: "#34C759" },
	googlechat: { label: "Google Chat", icon: GoogleChatIcon, color: "#00AC47" },
	nostr: { label: "Nostr", icon: NostrIcon, color: "#8B5CF6" },
	cron: { label: "Crons", icon: CronIcon, color: "var(--color-text-muted)" },
};

function ChannelIcon({ channel, size = 12 }: { channel: string; size?: number }) {
	const meta = CHANNEL_META[channel];
	if (!meta) return <ChatBubbleIcon />;
	const Icon = meta.icon;
	return (
		<span style={{ color: meta.color, width: size, height: size, display: "inline-flex" }}>
			<Icon />
		</span>
	);
}

function ConnectionDot({ status }: { status: "connected" | "running" | "configured" | "error" }) {
	const color = status === "connected" ? "#22c55e"
		: status === "running" ? "#eab308"
		: status === "error" ? "#ef4444"
		: "var(--color-text-muted)";
	return (
		<span
			className="inline-block rounded-full shrink-0"
			style={{ width: 6, height: 6, background: color }}
			title={status}
		/>
	);
}

// ── Reusable session row for web sessions ──

function WebSessionRow({
	session, isActive, isHovered, isStreaming, sessionSubagents,
	activeSubagentKey, renamingId, renameValue,
	onHover, onLeave, onSelect, onStartRename, onCommitRename, onCancelRename, onRenameChange,
	onDelete, onStop, onSelectSubagent, onStopSubagent, showFilePath,
}: {
	session: WebSession; isActive: boolean; isHovered: boolean; isStreaming: boolean;
	sessionSubagents?: SidebarSubagentInfo[]; activeSubagentKey?: string | null;
	renamingId: string | null; renameValue: string;
	onHover: (id: string) => void; onLeave: () => void;
	onSelect: (id: string) => void;
	onStartRename?: (id: string, title: string) => void;
	onCommitRename?: () => void; onCancelRename?: () => void;
	onRenameChange?: (val: string) => void;
	onDelete?: (id: string) => void; onStop?: (id: string) => void;
	onSelectSubagent?: (key: string) => void; onStopSubagent?: (key: string) => void;
	showFilePath?: boolean;
}) {
	const [ctxOpen, setCtxOpen] = useState(false);
	const showMore = isHovered || isStreaming || ctxOpen;
	const highlighted = isHovered || ctxOpen;
	const hasContextActions = !!(onStartRename || onDelete);
	const rowContent = (
		<div
			className="group relative"
			onMouseEnter={() => onHover(session.id)}
			onMouseLeave={() => { if (!ctxOpen) onLeave(); }}
		>
			<div
				className="flex items-stretch w-full rounded-xl"
				style={{
					background: isActive ? "var(--color-chat-sidebar-active-bg)"
						: highlighted ? "var(--color-surface-hover)" : "transparent",
				}}
			>
				{renamingId === session.id ? (
					<form className="flex-1 min-w-0 px-2 py-1.5" onSubmit={(e) => { e.preventDefault(); onCommitRename?.(); }}>
						<input
							type="text" value={renameValue}
							onChange={(e) => onRenameChange?.(e.target.value)}
							onBlur={onCommitRename}
							onKeyDown={(e) => { if (e.key === "Escape") onCancelRename?.(); }}
							autoFocus
							className="w-full text-xs font-medium px-1 py-0.5 rounded outline-none border"
							style={{ color: "var(--color-text)", background: "var(--color-surface)", borderColor: "var(--color-border)" }}
						/>
					</form>
				) : (
					<button type="button" onClick={() => onSelect(session.id)} className="flex-1 min-w-0 text-left px-2 py-2 rounded-l-lg transition-colors cursor-pointer">
						<div className="flex items-center gap-1.5">
							{isStreaming && <UnicodeSpinner name="braille" className="text-[10px] flex-shrink-0" style={{ color: "var(--color-chat-sidebar-muted)" }} />}
							<div className="text-xs font-medium truncate" style={{ color: isActive ? "var(--color-chat-sidebar-active-text)" : "var(--color-text)" }}>
								{session.title || "Untitled chat"}
							</div>
						</div>
						<div className="flex items-center gap-2 mt-0.5" style={{ paddingLeft: isStreaming ? "calc(0.375rem + 6px)" : undefined }}>
							<span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{timeAgo(session.updatedAt)}</span>
							{session.messageCount > 0 && (
								<span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
									{session.messageCount} msg{session.messageCount !== 1 ? "s" : ""}
								</span>
							)}
						</div>
						{showFilePath && session.filePath && (
							<div className="text-[9px] mt-0.5 truncate" style={{ color: "var(--color-text-muted)", opacity: 0.7 }}>
								{session.filePath}
							</div>
						)}
					</button>
				)}
				<div className={`shrink-0 flex items-center pr-1 gap-0.5 transition-opacity ${showMore ? "opacity-100" : "opacity-0"}`}>
					{isStreaming && onStop && (
						<button type="button" onClick={(e) => { e.stopPropagation(); onStop(session.id); }}
							className="flex items-center justify-center w-6 h-6 rounded-md transition-colors hover:bg-black/5"
							style={{ color: "var(--color-text-muted)" }} title="Stop chat" aria-label="Stop chat">
							<StopIcon />
						</button>
					)}
					{onDelete && (
						<DropdownMenu>
							<DropdownMenuTrigger onClick={(e) => e.stopPropagation()}
								className="flex items-center justify-center w-6 h-6 rounded-md"
								style={{ color: "var(--color-text-muted)" }} title="More options" aria-label="More options">
								<MoreHorizontalIcon />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" side="bottom">
								{onStartRename && (
									<DropdownMenuItem onSelect={() => onStartRename(session.id, session.title)}>
										<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /></svg>
										Rename
									</DropdownMenuItem>
								)}
								<DropdownMenuItem variant="destructive" onSelect={() => onDelete(session.id)}>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>
									Delete
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			</div>
			{sessionSubagents && sessionSubagents.length > 0 && (
				<div className="ml-4 border-l" style={{ borderColor: "var(--color-border)" }}>
					{sessionSubagents.map((sa) => {
						const isSubActive = activeSubagentKey === sa.childSessionKey;
						const isSubRunning = sa.status === "running";
						const subLabel = sa.label || sa.task;
						const truncated = subLabel.length > 40 ? subLabel.slice(0, 40) + "..." : subLabel;
						return (
							<div key={sa.childSessionKey} className="flex items-center">
								<button type="button" onClick={() => onSelectSubagent?.(sa.childSessionKey)}
									className="flex-1 text-left pl-3 pr-2 py-1.5 rounded-r-lg transition-colors cursor-pointer"
									style={{ background: isSubActive ? "var(--color-chat-sidebar-active-bg)" : "transparent" }}>
									<div className="flex items-center gap-1.5">
										{isSubRunning && <UnicodeSpinner name="braille" className="text-[9px] flex-shrink-0" style={{ color: "var(--color-chat-sidebar-muted)" }} />}
										<SubagentIcon />
										<span className="text-[11px] truncate" style={{ color: isSubActive ? "var(--color-chat-sidebar-active-text)" : "var(--color-text-muted)" }}>
											{truncated}
										</span>
									</div>
								</button>
								{isSubRunning && onStopSubagent && (
									<button type="button" onClick={(e) => { e.stopPropagation(); onStopSubagent(sa.childSessionKey); }}
										className="shrink-0 flex items-center justify-center w-6 h-6 rounded-md mr-1 transition-colors hover:bg-black/5"
										style={{ color: "var(--color-text-muted)" }} title="Stop subagent" aria-label="Stop subagent">
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

	if (!hasContextActions) return rowContent;

	return (
		<ContextMenu onOpenChange={(open) => { setCtxOpen(open); if (!open) onLeave(); }}>
			<ContextMenuTrigger asChild>
				{rowContent}
			</ContextMenuTrigger>
			<ContextMenuContent className="min-w-[160px]">
				{onStartRename && (
					<ContextMenuItem onSelect={() => onStartRename(session.id, session.title)}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /></svg>
						Rename
					</ContextMenuItem>
				)}
				{onDelete && (
					<ContextMenuItem variant="destructive" onSelect={() => onDelete(session.id)}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg>
						Delete
					</ContextMenuItem>
				)}
			</ContextMenuContent>
		</ContextMenu>
	);
}

// ── Gateway session row ──

function GatewaySessionRow({
	gs, isActive, isHovered, onHover, onLeave, onSelect,
}: {
	gs: SidebarGatewaySession; isActive: boolean; isHovered: boolean;
	onHover: (key: string) => void; onLeave: () => void;
	onSelect: (key: string, id: string) => void;
}) {
	return (
		<div onMouseEnter={() => onHover(gs.sessionKey)} onMouseLeave={onLeave}>
			<button type="button" onClick={() => onSelect(gs.sessionKey, gs.sessionId)}
				className="w-full text-left px-2 py-2 rounded-lg transition-colors cursor-pointer"
				style={{
					background: isActive ? "var(--color-chat-sidebar-active-bg)"
						: isHovered ? "var(--color-surface-hover)" : "transparent",
				}}>
				<div className="flex items-center gap-1.5">
					<ChannelIcon channel={gs.channel} size={11} />
					<div className="text-xs font-medium truncate" style={{ color: isActive ? "var(--color-chat-sidebar-active-text)" : "var(--color-text)" }}>
						{gs.title}
					</div>
				</div>
				<div className="flex items-center gap-2 mt-0.5 pl-[calc(11px+0.375rem)]">
					<span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{timeAgo(gs.updatedAt)}</span>
				</div>
			</button>
		</div>
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
	gatewaySessions,
	channelStatuses,
	activeGatewaySessionKey,
	onSelectGatewaySession,
	fileScopedSessions,
	heartbeatInfo,
}: ChatSessionsSidebarProps) {
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [activeFilter, setActiveFilter] = useState("denchclaw");

	const handleSelect = useCallback(
		(id: string) => { onSelectSession(id); onClose?.(); },
		[onSelectSession, onClose],
	);

	const handleSelectSubagentItem = useCallback(
		(sessionKey: string) => { onSelectSubagent?.(sessionKey); onClose?.(); },
		[onSelectSubagent, onClose],
	);

	const handleDeleteSession = useCallback(
		(sessionId: string) => { onDeleteSession?.(sessionId); },
		[onDeleteSession],
	);

	const handleStartRename = useCallback((sessionId: string, currentTitle: string) => {
		setRenamingId(sessionId);
		setRenameValue(currentTitle || "");
	}, []);

	const handleCommitRename = useCallback(() => {
		if (renamingId && renameValue.trim()) onRenameSession?.(renamingId, renameValue.trim());
		setRenamingId(null);
		setRenameValue("");
	}, [renamingId, renameValue, onRenameSession]);

	const handleCancelRename = useCallback(() => {
		setRenamingId(null);
		setRenameValue("");
	}, []);

	const handleSelectGateway = useCallback(
		(sessionKey: string, sessionId: string) => { onSelectGatewaySession?.(sessionKey, sessionId); onClose?.(); },
		[onSelectGatewaySession, onClose],
	);

	const subagentsByParent = useMemo(() => {
		const map = new Map<string, SidebarSubagentInfo[]>();
		if (!subagents) return map;
		for (const sa of subagents) {
			let list = map.get(sa.parentSessionId);
			if (!list) { list = []; map.set(sa.parentSessionId, list); }
			list.push(sa);
		}
		return map;
	}, [subagents]);

	const denchClawSessions = useMemo(
		() => sessions.filter((s) => !s.id.includes(":subagent:") && !s.filePath),
		[sessions],
	);

	const grouped = groupSessions(denchClawSessions);

	const channelStatusMap = useMemo(() => {
		const map = new Map<string, SidebarChannelStatus>();
		if (!channelStatuses) return map;
		for (const cs of channelStatuses) map.set(cs.id, cs);
		return map;
	}, [channelStatuses]);

	const gatewayByChannel = useMemo(() => {
		const map = new Map<string, SidebarGatewaySession[]>();
		if (!gatewaySessions) return map;
		for (const gs of gatewaySessions) {
			let list = map.get(gs.channel);
			if (!list) { list = []; map.set(gs.channel, list); }
			list.push(gs);
		}
		return map;
	}, [gatewaySessions]);

	const fileScopedGrouped = useMemo(
		() => groupSessions(fileScopedSessions ?? []),
		[fileScopedSessions],
	);

	const cronSessions = gatewayByChannel.get("cron");

	// ── Dynamic tab list ──
	const tabs = useMemo(() => {
		const result: SidebarTab[] = [
			{ id: "denchclaw", label: "DenchClaw", count: denchClawSessions.length },
		];
		const channelOrder = ["telegram", "whatsapp", "discord", "slack", "signal", "imessage", "googlechat", "nostr"];
		for (const channel of channelOrder) {
			const channelSessions = gatewayByChannel.get(channel);
			if (!channelSessions?.length) continue;
			const meta = CHANNEL_META[channel];
			result.push({
				id: channel,
				label: meta?.label ?? channel,
				icon: meta?.icon,
				iconColor: meta?.color,
				count: channelSessions.length,
			});
		}
		for (const [channel, channelSessions] of gatewayByChannel.entries()) {
			if (channelOrder.includes(channel) || channel === "cron" || channel === "unknown") continue;
			const meta = CHANNEL_META[channel];
			result.push({
				id: channel,
				label: meta?.label ?? channel,
				icon: meta?.icon,
				iconColor: meta?.color,
				count: channelSessions.length,
			});
		}
		if (cronSessions?.length) {
			result.push({ id: "cron", label: "Crons", icon: CronIcon, count: cronSessions.length });
			result.push({ id: "heartbeat", label: "Heartbeat", icon: HeartbeatIcon });
		}
		if ((fileScopedSessions?.length ?? 0) > 0) {
			result.push({ id: "other", label: "Other", icon: FileIcon, count: fileScopedSessions!.length });
		}
		return result;
	}, [denchClawSessions, gatewayByChannel, cronSessions, fileScopedSessions]);

	const hasTabs = tabs.length > 1;

	const width = mobile ? "280px" : (widthProp ?? 260);
	const headerHeight = embedded ? 36 : 40;
	const filterHeight = hasTabs ? 30 : 0;

	// ── Content renderer per active filter ──
	const renderContent = () => {
		if (loading && sessions.length === 0 && !(gatewaySessions?.length)) {
			return (
				<div className="px-4 py-8 flex flex-col items-center justify-center min-h-[120px]">
					<UnicodeSpinner name="braille" className="text-xl mb-2" style={{ color: "var(--color-text-muted)" }} />
					<p className="text-xs" style={{ color: "var(--color-text-muted)" }}>Loading…</p>
				</div>
			);
		}

		if (activeFilter === "denchclaw") {
			if (denchClawSessions.length === 0) {
				return (
					<div className="px-4 py-8 text-center">
						<div className="mx-auto w-10 h-10 rounded-xl flex items-center justify-center mb-3" style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}>
							<ChatBubbleIcon />
						</div>
						<p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
							No conversations yet.<br />Start a new chat to begin.
						</p>
					</div>
				);
			}
			return (
				<div className="px-2 py-1">
					{grouped.map((group) => (
						<div key={group.label}>
							<div className="px-2 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--color-text-muted)" }}>
								{group.label}
							</div>
							{group.sessions.map((session) => (
								<WebSessionRow
									key={session.id}
									session={session}
									isActive={session.id === activeSessionId && !activeSubagentKey && !activeGatewaySessionKey}
									isHovered={session.id === hoveredId}
									isStreaming={streamingSessionIds?.has(session.id) ?? false}
									sessionSubagents={subagentsByParent.get(session.id)}
									activeSubagentKey={activeSubagentKey}
									renamingId={renamingId} renameValue={renameValue}
									onHover={setHoveredId} onLeave={() => setHoveredId(null)}
									onSelect={handleSelect}
									onStartRename={onRenameSession ? handleStartRename : undefined}
									onCommitRename={handleCommitRename} onCancelRename={handleCancelRename}
									onRenameChange={setRenameValue}
									onDelete={onDeleteSession ? handleDeleteSession : undefined}
									onStop={onStopSession}
									onSelectSubagent={handleSelectSubagentItem}
									onStopSubagent={onStopSubagent}
								/>
							))}
						</div>
					))}
				</div>
			);
		}

		if (activeFilter === "heartbeat") {
			return (
				<div className="px-2 py-1">
					{/* Gateway health card */}
					<div className="mx-1 mb-2 p-2.5 rounded-lg" style={{ background: "var(--color-surface-hover)" }}>
						<div className="flex items-center gap-2 mb-1.5">
							<ConnectionDot status={channelStatuses?.some((c) => c.connected) ? "connected" : channelStatuses?.some((c) => c.running) ? "running" : "configured"} />
							<span className="text-[11px] font-medium" style={{ color: "var(--color-text)" }}>
								Gateway {channelStatuses?.some((c) => c.connected) ? "Connected" : "Disconnected"}
							</span>
						</div>
						{heartbeatInfo && (
							<div className="space-y-0.5">
								<div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
									Interval: {Math.round(heartbeatInfo.intervalMs / 60000)}m
								</div>
								{heartbeatInfo.nextDueEstimateMs && (
									<div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
										Next: {timeAgo(heartbeatInfo.nextDueEstimateMs).replace(" ago", "")} from now
									</div>
								)}
							</div>
						)}
						{!heartbeatInfo && (
							<div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>No heartbeat data</div>
						)}
					</div>
					{/* Cron sessions */}
					{cronSessions?.map((gs) => (
						<GatewaySessionRow
							key={gs.sessionKey} gs={gs}
							isActive={activeGatewaySessionKey === gs.sessionKey}
							isHovered={hoveredId === gs.sessionKey}
							onHover={setHoveredId} onLeave={() => setHoveredId(null)}
							onSelect={handleSelectGateway}
						/>
					))}
					{!cronSessions?.length && (
						<div className="px-4 py-6 text-center">
							<p className="text-xs" style={{ color: "var(--color-text-muted)" }}>No cron sessions</p>
						</div>
					)}
				</div>
			);
		}

		if (activeFilter === "other") {
			if (!fileScopedSessions?.length) {
				return (
					<div className="px-4 py-8 text-center">
						<p className="text-xs" style={{ color: "var(--color-text-muted)" }}>No file-scoped sessions</p>
					</div>
				);
			}
			return (
				<div className="px-2 py-1">
					{fileScopedGrouped.map((group) => (
						<div key={group.label}>
							<div className="px-2 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--color-text-muted)" }}>
								{group.label}
							</div>
							{group.sessions.map((session) => (
								<WebSessionRow
									key={session.id}
									session={session}
									isActive={session.id === activeSessionId && !activeSubagentKey && !activeGatewaySessionKey}
									isHovered={session.id === hoveredId}
									isStreaming={streamingSessionIds?.has(session.id) ?? false}
									renamingId={renamingId} renameValue={renameValue}
									onHover={setHoveredId} onLeave={() => setHoveredId(null)}
									onSelect={handleSelect}
									onCommitRename={handleCommitRename} onCancelRename={handleCancelRename}
									onRenameChange={setRenameValue}
									onDelete={onDeleteSession ? handleDeleteSession : undefined}
									showFilePath
								/>
							))}
						</div>
					))}
				</div>
			);
		}

		// Channel-specific tab (telegram, whatsapp, discord, cron, etc.)
		const channelSessions = gatewayByChannel.get(activeFilter);
		const status = channelStatusMap.get(activeFilter);
		const connectionState = status?.connected ? "connected"
			: status?.running ? "running"
			: status?.error ? "error"
			: status?.configured ? "configured"
			: undefined;

		if (!channelSessions?.length) {
			return (
				<div className="px-4 py-8 text-center">
					<p className="text-xs" style={{ color: "var(--color-text-muted)" }}>No sessions</p>
				</div>
			);
		}

		return (
			<div className="px-2 py-1">
				{connectionState && (
					<div className="px-2 pt-2 pb-1 flex items-center gap-1.5">
						<ConnectionDot status={connectionState} />
						<span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
							{connectionState === "connected" ? "Connected" : connectionState === "running" ? "Running" : connectionState === "error" ? "Error" : "Configured"}
						</span>
					</div>
				)}
				{channelSessions.map((gs) => (
					<GatewaySessionRow
						key={gs.sessionKey} gs={gs}
						isActive={activeGatewaySessionKey === gs.sessionKey}
						isHovered={hoveredId === gs.sessionKey}
						onHover={setHoveredId} onLeave={() => setHoveredId(null)}
						onSelect={handleSelectGateway}
					/>
				))}
			</div>
		);
	};

	const content = (
		<div className="flex-1 min-h-0 relative">
			<div className="absolute inset-0 overflow-y-auto" style={{ paddingTop: headerHeight + filterHeight }}>
				{renderContent()}
			</div>

			{/* Header */}
			<div
			className={`absolute top-0 left-0 right-0 z-10 backdrop-blur-md ${embedded ? "" : "border-b"}`}
			style={{
				borderColor: embedded ? undefined : "var(--color-border)",
				background: "color-mix(in srgb, var(--color-bg) 80%, transparent)",
				boxShadow: embedded ? "inset 0 -1px 0 0 var(--color-border)" : undefined,
			}}
			>
				<div className="flex items-center justify-between px-4" style={{ height: headerHeight }}>
					<div className="min-w-0 flex-1 flex items-center gap-1.5">
						{onCollapse && (
							<button type="button" onClick={onCollapse}
								className="p-1 rounded-md shrink-0 transition-colors hover:bg-black/5"
								style={{ color: "var(--color-text-muted)" }} title="Hide chat sidebar">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" />
								</svg>
							</button>
						)}
						<span className="text-xs font-medium truncate block" style={{ color: "var(--color-text)" }}>
							Chats
						</span>
					</div>
					<button type="button" onClick={onNewSession}
						className={`flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium transition-all cursor-pointer shrink-0 ml-1.5 ${embedded ? "hover:bg-neutral-400/15" : ""}`}
						style={{
							color: embedded ? "var(--color-text)" : "var(--color-chat-sidebar-active-text)",
							background: embedded ? "transparent" : "var(--color-chat-sidebar-active-bg)",
						}}
						title="New chat">
						<PlusIcon />
						New
					</button>
				</div>
				{/* Dynamic tab strip */}
				{hasTabs && (
					<div className="flex items-center gap-0.5 px-2 pb-1.5 overflow-x-auto scrollbar-none">
						{tabs.map((tab) => {
							const isActive = activeFilter === tab.id;
							const TabIcon = tab.icon;
							return (
								<button
									key={tab.id} type="button"
									onClick={() => setActiveFilter(tab.id)}
									className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors cursor-pointer shrink-0 whitespace-nowrap"
									style={{
										color: isActive ? "var(--color-chat-sidebar-active-text)" : "var(--color-text-muted)",
										background: isActive ? "var(--color-chat-sidebar-active-bg)" : "transparent",
									}}
								>
									{TabIcon && (
										<span style={{ color: isActive ? undefined : (tab.iconColor ?? "var(--color-text-muted)"), display: "inline-flex" }}>
											<TabIcon />
										</span>
									)}
									{tab.label}
									{tab.count !== undefined && tab.count > 0 && (
										<span className="text-[9px] opacity-60">{tab.count}</span>
									)}
								</button>
							);
						})}
					</div>
				)}
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
		if (t >= todayStart) today.push(s);
		else if (t >= yesterdayStart) yesterday.push(s);
		else if (t >= weekStart) thisWeek.push(s);
		else if (t >= monthStart) thisMonth.push(s);
		else older.push(s);
	}

	const groups: SessionGroup[] = [];
	if (today.length > 0) groups.push({ label: "Today", sessions: today });
	if (yesterday.length > 0) groups.push({ label: "Yesterday", sessions: yesterday });
	if (thisWeek.length > 0) groups.push({ label: "This Week", sessions: thisWeek });
	if (thisMonth.length > 0) groups.push({ label: "This Month", sessions: thisMonth });
	if (older.length > 0) groups.push({ label: "Older", sessions: older });
	return groups;
}
