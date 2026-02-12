"use client";

import { useEffect, useState } from "react";

// --- Types ---

type WebSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
};

type SkillEntry = {
  name: string;
  description: string;
  emoji?: string;
  source: string;
};

type MemoryFile = {
  name: string;
  sizeBytes: number;
};

type TreeNode = {
  name: string;
  path: string;
  type: "object" | "document" | "folder" | "file" | "database";
  icon?: string;
  defaultView?: "table" | "kanban";
  children?: TreeNode[];
};

type SidebarSection = "chats" | "skills" | "memories" | "workspace";

type SidebarProps = {
  onSessionSelect?: (sessionId: string) => void;
  onNewSession?: () => void;
  activeSessionId?: string;
  refreshKey?: number;
};

// --- Helpers ---

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) {return `${seconds}s ago`;}
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {return `${minutes}m ago`;}
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {return `${hours}h ago`;}
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// --- Section Components ---

function ChatsSection({
  sessions,
  onSessionSelect,
  activeSessionId,
}: {
  sessions: WebSession[];
  onSessionSelect?: (sessionId: string) => void;
  activeSessionId?: string;
}) {
  const [searchTerm, setSearchTerm] = useState("");

  const filteredSessions = sessions.filter((s) =>
    s.title.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  return (
    <div className="space-y-2">
      {sessions.length > 3 && (
        <div className="px-3">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search chats..."
            className="w-full px-3 py-1.5 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] focus:border-transparent"
          />
        </div>
      )}

      {filteredSessions.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)] px-3">
          {searchTerm ? "No matching chats." : "No chats yet. Send a message to start."}
        </p>
      ) : (
        <div className="space-y-0.5">
          {filteredSessions.map((s) => {
            const isActive = s.id === activeSessionId;
            return (
              <div
                key={s.id}
                onClick={() => onSessionSelect?.(s.id)}
                className={`mx-2 px-3 py-2 rounded-lg hover:bg-[var(--color-surface-hover)] cursor-pointer transition-colors ${
                  isActive
                    ? "bg-[var(--color-surface-hover)] border-l-2 border-[var(--color-accent)]"
                    : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm truncate flex-1">{s.title}</span>
                  <span className="text-xs text-[var(--color-text-muted)] flex-shrink-0">
                    {timeAgo(s.updatedAt)}
                  </span>
                </div>
                {s.messageCount > 0 && (
                  <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                    {s.messageCount} message{s.messageCount !== 1 ? "s" : ""}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SkillsSection({ skills }: { skills: SkillEntry[] }) {
  if (skills.length === 0) {
    return <p className="text-sm text-[var(--color-text-muted)] px-3">No skills found.</p>;
  }

  return (
    <div className="space-y-1">
      {skills.map((skill) => (
        <div
          key={`${skill.source}:${skill.name}`}
          className="px-3 py-2 rounded-lg hover:bg-[var(--color-surface-hover)] transition-colors"
        >
          <div className="flex items-center gap-2">
            {skill.emoji && <span className="text-base">{skill.emoji}</span>}
            <span className="text-sm font-medium">{skill.name}</span>
            <span className="text-xs text-[var(--color-text-muted)] ml-auto">{skill.source}</span>
          </div>
          {skill.description && (
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5 line-clamp-2">
              {skill.description}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function MemoriesSection({
  mainMemory,
  dailyLogs,
}: {
  mainMemory: string | null;
  dailyLogs: MemoryFile[];
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="space-y-2">
      {mainMemory ? (
        <div className="px-3">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] mb-1"
          >
            {expanded ? "Collapse" : "Show"} MEMORY.md ({mainMemory.length} chars)
          </button>
          {expanded && (
            <pre className="text-xs text-[var(--color-text-muted)] bg-[var(--color-bg)] rounded p-2 overflow-auto max-h-64 whitespace-pre-wrap">
              {mainMemory}
            </pre>
          )}
        </div>
      ) : (
        <p className="text-sm text-[var(--color-text-muted)] px-3">No MEMORY.md found.</p>
      )}

      {dailyLogs.length > 0 && (
        <div className="px-3">
          <p className="text-xs text-[var(--color-text-muted)] mb-1">
            Daily logs ({dailyLogs.length})
          </p>
          <div className="space-y-0.5">
            {dailyLogs.slice(0, 10).map((log) => (
              <div
                key={log.name}
                className="text-xs text-[var(--color-text-muted)] flex justify-between"
              >
                <span>{log.name}</span>
                <span>{(log.sizeBytes / 1024).toFixed(1)}kb</span>
              </div>
            ))}
            {dailyLogs.length > 10 && (
              <p className="text-xs text-[var(--color-text-muted)]">
                ...and {dailyLogs.length - 10} more
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Workspace Section ---

function WorkspaceTreeNode({
  node,
  depth,
  expanded,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}) {
  const hasChildren = node.children && node.children.length > 0;
  const isExpandable = hasChildren || node.type === "folder" || node.type === "object";
  const isOpen = expanded.has(node.path);

  const iconColor =
    node.type === "object"
      ? "var(--color-accent)"
      : node.type === "document"
        ? "#60a5fa"
        : node.type === "database"
          ? "#c084fc"
          : "var(--color-text-muted)";

  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-1 px-2 rounded-md text-sm cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)]"
        style={{ paddingLeft: `${depth * 14 + 8}px`, color: "var(--color-text-muted)" }}
        onClick={() => {
          if (isExpandable) {onToggle(node.path);}
          // Navigate to workspace page for actionable items
          if (node.type === "object" || node.type === "document" || node.type === "file" || node.type === "database") {
            window.location.href = `/workspace?path=${encodeURIComponent(node.path)}`;
          }
        }}
      >
        {/* Chevron */}
        <span className="w-3.5 flex-shrink-0 flex items-center justify-center" style={{ opacity: isExpandable ? 1 : 0 }}>
          {isExpandable && (
            <svg
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 150ms" }}
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
          )}
        </span>

        {/* Icon */}
        <span className="flex-shrink-0" style={{ color: iconColor }}>
          {node.type === "object" ? (
            node.defaultView === "kanban" ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="6" height="14" x="2" y="5" rx="1" /><rect width="6" height="10" x="9" y="5" rx="1" /><rect width="6" height="16" x="16" y="3" rx="1" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v18" /><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" />
              </svg>
            )
          ) : node.type === "document" ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" />
            </svg>
          ) : node.type === "folder" ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
            </svg>
          ) : node.type === "database" ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M3 5V19A9 3 0 0 0 21 19V5" />
              <path d="M3 12A9 3 0 0 0 21 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" />
            </svg>
          )}
        </span>

        {/* Name */}
        <span className="truncate flex-1 text-xs">{node.name.replace(/\.md$/, "")}</span>

        {/* Type badge for objects */}
        {node.type === "object" && (
          <span
            className="text-[9px] px-1 py-0 rounded flex-shrink-0"
            style={{ background: "rgba(232,93,58,0.15)", color: "var(--color-accent)" }}
          >
            {node.defaultView === "kanban" ? "board" : "table"}
          </span>
        )}
      </div>

      {isOpen && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <WorkspaceTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceSection({ tree }: { tree: TreeNode[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Auto-expand first level
    const initial = new Set<string>();
    for (const node of tree) {
      if (node.children && node.children.length > 0) {
        initial.add(node.path);
      }
    }
    return initial;
  });

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {next.delete(path);}
      else {next.add(path);}
      return next;
    });
  };

  if (tree.length === 0) {
    return (
      <p className="text-xs text-[var(--color-text-muted)] px-3 py-1">
        No workspace data yet.
      </p>
    );
  }

  return (
    <div className="space-y-0.5">
      {tree.map((node) => (
        <WorkspaceTreeNode
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          onToggle={toggle}
        />
      ))}

      {/* Full workspace link */}
      <a
        href="/workspace"
        className="flex items-center gap-1.5 mx-2 mt-2 px-2 py-1.5 rounded-md text-xs transition-colors hover:bg-[var(--color-surface-hover)]"
        style={{ color: "var(--color-accent)" }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" x2="21" y1="14" y2="3" />
        </svg>
        Open full workspace
      </a>
    </div>
  );
}

// --- Collapsible Header ---

function SectionHeader({
  title,
  count,
  isOpen,
  onToggle,
}: {
  title: string;
  count?: number;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between px-3 py-2 text-sm font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] rounded-lg transition-colors"
    >
      <span>
        {title}
        {count != null && (
          <span className="ml-1.5 text-xs text-[var(--color-text-muted)] font-normal">
            ({count})
          </span>
        )}
      </span>
      <svg
        className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${isOpen ? "rotate-180" : ""}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  );
}

// --- Main Sidebar ---

export function Sidebar({
  onSessionSelect,
  onNewSession,
  activeSessionId,
  refreshKey,
}: SidebarProps) {
  const [openSections, setOpenSections] = useState<Set<SidebarSection>>(new Set(["chats", "workspace"]));
  const [webSessions, setWebSessions] = useState<WebSession[]>([]);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [mainMemory, setMainMemory] = useState<string | null>(null);
  const [dailyLogs, setDailyLogs] = useState<MemoryFile[]>([]);
  const [workspaceTree, setWorkspaceTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);

  const toggleSection = (section: SidebarSection) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {next.delete(section);}
      else {next.add(section);}
      return next;
    });
  };

  // Fetch sidebar data (re-runs when refreshKey changes)
  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [webSessionsRes, skillsRes, memoriesRes, workspaceRes] = await Promise.all([
          fetch("/api/web-sessions").then((r) => r.json()),
          fetch("/api/skills").then((r) => r.json()),
          fetch("/api/memories").then((r) => r.json()),
          fetch("/api/workspace/tree").then((r) => r.json()).catch(() => ({ tree: [] })),
        ]);
        setWebSessions(webSessionsRes.sessions ?? []);
        setSkills(skillsRes.skills ?? []);
        setMainMemory(memoriesRes.mainMemory ?? null);
        setDailyLogs(memoriesRes.dailyLogs ?? []);
        setWorkspaceTree(workspaceRes.tree ?? []);
      } catch (err) {
        console.error("Failed to load sidebar data:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [refreshKey]);

  return (
    <aside className="w-72 h-screen flex flex-col bg-[var(--color-surface)] border-r border-[var(--color-border)] overflow-hidden">
      {/* Header with New Chat button */}
      <div className="px-4 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
        <h1 className="text-base font-bold flex items-center gap-2">
          <span className="text-xl">🦞</span>
          <span>OpenClaw</span>
        </h1>
        <button
          onClick={onNewSession}
          title="New Chat"
          className="p-1.5 rounded-md hover:bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 4v16m8-8H4"
            />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto py-2 space-y-1">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 border-2 border-[var(--color-border)] border-t-[var(--color-accent)] rounded-full animate-spin" />
          </div>
        ) : (
          <>
            {/* Chats (web sessions) */}
            <div>
              <SectionHeader
                title="Chats"
                count={webSessions.length}
                isOpen={openSections.has("chats")}
                onToggle={() => toggleSection("chats")}
              />
              {openSections.has("chats") && (
                <ChatsSection
                  sessions={webSessions}
                  onSessionSelect={onSessionSelect}
                  activeSessionId={activeSessionId}
                />
              )}
            </div>

            {/* Workspace */}
            {workspaceTree.length > 0 && (
              <div>
                <SectionHeader
                  title="Workspace"
                  count={workspaceTree.length}
                  isOpen={openSections.has("workspace")}
                  onToggle={() => toggleSection("workspace")}
                />
                {openSections.has("workspace") && (
                  <WorkspaceSection tree={workspaceTree} />
                )}
              </div>
            )}

            {/* Skills */}
            <div>
              <SectionHeader
                title="Skills"
                count={skills.length}
                isOpen={openSections.has("skills")}
                onToggle={() => toggleSection("skills")}
              />
              {openSections.has("skills") && <SkillsSection skills={skills} />}
            </div>

            {/* Memories */}
            <div>
              <SectionHeader
                title="Memories"
                count={dailyLogs.length}
                isOpen={openSections.has("memories")}
                onToggle={() => toggleSection("memories")}
              />
              {openSections.has("memories") && (
                <MemoriesSection mainMemory={mainMemory} dailyLogs={dailyLogs} />
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
