"use client";

import { Suspense, useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { WorkspaceSidebar } from "../components/workspace/workspace-sidebar";
import { type TreeNode } from "../components/workspace/file-manager-tree";
import { useWorkspaceWatcher } from "../hooks/use-workspace-watcher";
import { ObjectTable } from "../components/workspace/object-table";
import { ObjectKanban } from "../components/workspace/object-kanban";
import { DocumentView } from "../components/workspace/document-view";
import { FileViewer, isSpreadsheetFile } from "../components/workspace/file-viewer";
import { HtmlViewer } from "../components/workspace/html-viewer";
import { CodeViewer } from "../components/workspace/code-viewer";
import { MediaViewer, detectMediaType, type MediaType } from "../components/workspace/media-viewer";
import { DatabaseViewer, DuckDBMissing } from "../components/workspace/database-viewer";
import { Breadcrumbs } from "../components/workspace/breadcrumbs";
import { ChatSessionsSidebar } from "../components/workspace/chat-sessions-sidebar";
import { EmptyState } from "../components/workspace/empty-state";
import { ReportViewer } from "../components/charts/report-viewer";
import { ChatPanel, type ChatPanelHandle, type SubagentSpawnInfo } from "../components/chat-panel";
import { SubagentPanel } from "../components/subagent-panel";
import { EntryDetailModal } from "../components/workspace/entry-detail-modal";
import { useSearchIndex } from "@/lib/search-index";
import { parseWorkspaceLink, isWorkspaceLink } from "@/lib/workspace-links";
import { isCodeFile } from "@/lib/report-utils";
import { CronDashboard } from "../components/cron/cron-dashboard";
import { CronJobDetail } from "../components/cron/cron-job-detail";
import type { CronJob, CronJobsResponse } from "../types/cron";
import { useIsMobile } from "../hooks/use-mobile";
import { ObjectFilterBar } from "../components/workspace/object-filter-bar";
import { type FilterGroup, type SortRule, type SavedView, emptyFilterGroup, serializeFilters } from "@/lib/object-filters";
import { UnicodeSpinner } from "../components/unicode-spinner";
import { resolveActiveViewSyncDecision } from "./object-view-active-view";

// --- Types ---

type WorkspaceContext = {
  exists: boolean;
  organization?: { id?: string; name?: string; slug?: string };
  members?: Array<{ id: string; name: string; email: string; role: string }>;
};

type ReverseRelation = {
  fieldName: string;
  sourceObjectName: string;
  sourceObjectId: string;
  displayField: string;
  entries: Record<string, Array<{ id: string; label: string }>>;
};

type ObjectData = {
  object: {
    id: string;
    name: string;
    description?: string;
    icon?: string;
    default_view?: string;
    display_field?: string;
  };
  fields: Array<{
    id: string;
    name: string;
    type: string;
    enum_values?: string[];
    enum_colors?: string[];
    enum_multiple?: boolean;
    related_object_id?: string;
    relationship_type?: string;
    related_object_name?: string;
    sort_order?: number;
  }>;
  statuses: Array<{
    id: string;
    name: string;
    color?: string;
    sort_order?: number;
  }>;
  entries: Record<string, unknown>[];
  relationLabels?: Record<string, Record<string, string>>;
  reverseRelations?: ReverseRelation[];
  effectiveDisplayField?: string;
  savedViews?: import("@/lib/object-filters").SavedView[];
  activeView?: string;
  totalCount?: number;
  page?: number;
  pageSize?: number;
};

type FileData = {
  content: string;
  type: "markdown" | "yaml" | "code" | "text";
};

type ContentState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "object"; data: ObjectData }
  | { kind: "document"; data: FileData; title: string }
  | { kind: "file"; data: FileData; filename: string }
  | { kind: "code"; data: FileData; filename: string }
  | { kind: "media"; url: string; mediaType: MediaType; filename: string; filePath: string }
  | { kind: "spreadsheet"; url: string; filename: string }
  | { kind: "html"; rawUrl: string; contentUrl: string; filename: string }
  | { kind: "database"; dbPath: string; filename: string }
  | { kind: "report"; reportPath: string; filename: string }
  | { kind: "directory"; node: TreeNode }
  | { kind: "cron-dashboard" }
  | { kind: "cron-job"; jobId: string; job: CronJob }
  | { kind: "duckdb-missing" };

type SidebarPreviewContent =
  | { kind: "document"; data: FileData; title: string }
  | { kind: "file"; data: FileData; filename: string }
  | { kind: "code"; data: FileData; filename: string }
  | { kind: "media"; url: string; mediaType: MediaType; filename: string; filePath: string }
  | { kind: "database"; dbPath: string; filename: string }
  | { kind: "directory"; path: string; name: string };

type ChatSidebarPreviewState =
  | { status: "loading"; path: string; filename: string }
  | { status: "error"; path: string; filename: string; message: string }
  | { status: "ready"; path: string; filename: string; content: SidebarPreviewContent };

type WebSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
};

// --- Helpers ---

/** Detect virtual paths (skills, memories) that live outside the main workspace. */
function isVirtualPath(path: string): boolean {
  return path.startsWith("~") && !path.startsWith("~/");
}

/** Detect absolute filesystem paths (browse mode). */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/");
}

/** Detect home-relative filesystem paths (e.g. ~/Desktop/file.txt). */
function isHomeRelativePath(path: string): boolean {
  return path.startsWith("~/");
}

/** Pick the right file API endpoint based on virtual vs real vs absolute paths. */
function fileApiUrl(path: string): string {
  if (isVirtualPath(path)) {
    return `/api/workspace/virtual-file?path=${encodeURIComponent(path)}`;
  }
  if (isAbsolutePath(path) || isHomeRelativePath(path)) {
    return `/api/workspace/browse-file?path=${encodeURIComponent(path)}`;
  }
  return `/api/workspace/file?path=${encodeURIComponent(path)}`;
}

/** Pick the right raw file URL for media preview. */
function rawFileUrl(path: string): string {
  if (isAbsolutePath(path) || isHomeRelativePath(path)) {
    return `/api/workspace/browse-file?path=${encodeURIComponent(path)}&raw=true`;
  }
  return `/api/workspace/raw-file?path=${encodeURIComponent(path)}`;
}

const LEFT_SIDEBAR_MIN = 200;
const LEFT_SIDEBAR_MAX = 480;
const RIGHT_SIDEBAR_MIN = 260;
const RIGHT_SIDEBAR_MAX = 900;
const STORAGE_LEFT = "ironclaw-workspace-left-sidebar-width";
const STORAGE_RIGHT = "ironclaw-workspace-right-sidebar-width";

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Vertical resize handle; uses cursor position so the handle follows the mouse (no stuck-at-limit). */
function ResizeHandle({
  mode,
  containerRef,
  min,
  max,
  onResize,
}: {
  mode: "left" | "right";
  containerRef: React.RefObject<HTMLElement | null>;
  min: number;
  max: number;
  onResize: (width: number) => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      const move = (ev: MouseEvent) => {
        const el = containerRef.current;
        if (!el) {return;}
        const rect = el.getBoundingClientRect();
        const width =
          mode === "left"
            ? ev.clientX - rect.left
            : rect.right - ev.clientX;
        onResize(clamp(width, min, max));
      };
      const up = () => {
        setIsDragging(false);
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.style.removeProperty("user-select");
        document.body.style.removeProperty("cursor");
        document.body.classList.remove("resizing");
      };
      document.body.style.setProperty("user-select", "none");
      document.body.style.setProperty("cursor", "col-resize");
      document.body.classList.add("resizing");
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    },
    [containerRef, mode, min, max, onResize],
  );
  const showHover = isDragging || undefined;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={onMouseDown}
      className={`cursor-col-resize flex justify-center transition-colors ${showHover ? "bg-blue-600/30" : "hover:bg-blue-600/30"}`}
      style={{ position: "absolute", [mode === "left" ? "right" : "left"]: -2, top: 0, bottom: 0, width: 4, zIndex: 20 }}
    />
  );
}

/** Find a node in the tree by exact path. */
function findNode(
  tree: TreeNode[],
  path: string,
): TreeNode | null {
  for (const node of tree) {
    if (node.path === path) {return node;}
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) {return found;}
    }
  }
  return null;
}

/** Extract the object name from a tree path (last segment). */
function objectNameFromPath(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1];
}

/** Infer a tree node type from filename extension for ad-hoc path previews. */
function inferNodeTypeFromFileName(fileName: string): TreeNode["type"] {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "mdx") {return "document";}
  if (ext === "duckdb" || ext === "sqlite" || ext === "sqlite3" || ext === "db") {return "database";}
  return "file";
}

/** Normalize chat path references (supports file:// URLs). */
function normalizeChatPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith("file://")) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "file:") {
      return trimmed;
    }
    const decoded = decodeURIComponent(url.pathname);
    // Windows file URLs are /C:/... in URL form
    if (/^\/[A-Za-z]:\//.test(decoded)) {
      return decoded.slice(1);
    }
    return decoded;
  } catch {
    return trimmed;
  }
}

/**
 * Resolve a path with fallback strategies:
 * 1. Exact match
 * 2. Try with knowledge/ prefix
 * 3. Try stripping knowledge/ prefix
 * 4. Match last segment against object names
 */
function resolveNode(
  tree: TreeNode[],
  path: string,
): TreeNode | null {
  let node = findNode(tree, path);
  if (node) {return node;}

  if (!path.startsWith("knowledge/")) {
    node = findNode(tree, `knowledge/${path}`);
    if (node) {return node;}
  }

  if (path.startsWith("knowledge/")) {
    node = findNode(tree, path.slice("knowledge/".length));
    if (node) {return node;}
  }

  const lastSegment = path.split("/").pop();
  if (lastSegment) {
    function findByName(nodes: TreeNode[]): TreeNode | null {
      for (const n of nodes) {
        if (n.type === "object" && objectNameFromPath(n.path) === lastSegment) {return n;}
        if (n.children) {
          const found = findByName(n.children);
          if (found) {return found;}
        }
      }
      return null;
    }
    node = findByName(tree);
    if (node) {return node;}
  }

  return null;
}

// --- Main Page ---

export default function WorkspacePage() {
  return (
    <Suspense fallback={
      <div className="flex h-screen items-center justify-center" style={{ background: "var(--color-bg)" }}>
        <UnicodeSpinner name="braille" className="text-2xl" style={{ color: "var(--color-text-muted)" }} />
      </div>
    }>
      <WorkspacePageInner />
    </Suspense>
  );
}

function WorkspacePageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialPathHandled = useRef(false);

  // Chat panel ref for session management
  const chatRef = useRef<ChatPanelHandle>(null);
  // Compact (file-scoped) chat panel ref for sidebar drag-and-drop
  const compactChatRef = useRef<ChatPanelHandle>(null);
  // Root layout ref for resize handle position (handle follows cursor)
  const layoutRef = useRef<HTMLDivElement>(null);

  // Live-reactive tree via SSE watcher (with browse-mode support)
  const {
    tree, loading: treeLoading, exists: workspaceExists, refresh: refreshTree,
    reconnect: reconnectWorkspaceWatcher,
    browseDir, setBrowseDir, parentDir: browseParentDir, workspaceRoot, openclawDir,
    activeProfile: workspaceProfile,
    showHidden, setShowHidden,
  } = useWorkspaceWatcher();

  // Search index for @ mention fuzzy search (files + entries)
  const { search: searchIndex } = useSearchIndex();

  const [context, setContext] = useState<WorkspaceContext | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState<ContentState>({ kind: "none" });
  const [showChatSidebar, setShowChatSidebar] = useState(true);
  const [chatSidebarPreview, setChatSidebarPreview] = useState<ChatSidebarPreviewState | null>(null);

  // Chat session state
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<WebSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  const [streamingSessionIds, setStreamingSessionIds] = useState<Set<string>>(new Set());

  // Subagent tracking
  const [subagents, setSubagents] = useState<SubagentSpawnInfo[]>([]);
  const [activeSubagentKey, setActiveSubagentKey] = useState<string | null>(null);

  const handleSubagentSpawned = useCallback((info: SubagentSpawnInfo) => {
    setSubagents((prev) => {
      const idx = prev.findIndex((sa) => sa.childSessionKey === info.childSessionKey);
      if (idx >= 0) {
        // Update status if changed
        if (prev[idx].status === info.status) {return prev;}
        const updated = [...prev];
        updated[idx] = { ...prev[idx], ...info };
        return updated;
      }
      return [...prev, info];
    });
  }, []);

  const handleSelectSubagent = useCallback((sessionKey: string) => {
    setActiveSubagentKey(sessionKey);
  }, []);

  const handleBackFromSubagent = useCallback(() => {
    setActiveSubagentKey(null);
  }, []);

  // Navigate to a subagent panel when its card is clicked in the chat
  const handleSubagentClickFromChat = useCallback((task: string) => {
    const match = subagents.find((sa) => sa.task === task);
    if (match) {
      setActiveSubagentKey(match.childSessionKey);
    }
  }, [subagents]);

  // Find the active subagent's info for the panel
  const activeSubagent = useMemo(() => {
    if (!activeSubagentKey) {return null;}
    return subagents.find((sa) => sa.childSessionKey === activeSubagentKey) ?? null;
  }, [activeSubagentKey, subagents]);

  // Cron jobs state
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);

  // Entry detail modal state
  const [entryModal, setEntryModal] = useState<{
    objectName: string;
    entryId: string;
  } | null>(null);

  // Mobile responsive state
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatSessionsOpen, setChatSessionsOpen] = useState(false);

  // Sidebar collapse state (desktop only).
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);

  // Resizable sidebar widths (desktop only; persisted in localStorage).
  // Use static defaults so server and client match on first render (avoid hydration mismatch).
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(260);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(320);
  useEffect(() => {
    const left = window.localStorage.getItem(STORAGE_LEFT);
    const nLeft = left ? parseInt(left, 10) : NaN;
    if (Number.isFinite(nLeft)) {
      setLeftSidebarWidth(clamp(nLeft, LEFT_SIDEBAR_MIN, LEFT_SIDEBAR_MAX));
    }
    const right = window.localStorage.getItem(STORAGE_RIGHT);
    const nRight = right ? parseInt(right, 10) : NaN;
    if (Number.isFinite(nRight)) {
      setRightSidebarWidth(clamp(nRight, RIGHT_SIDEBAR_MIN, RIGHT_SIDEBAR_MAX));
    }
  }, []);
  useEffect(() => {
    window.localStorage.setItem(STORAGE_LEFT, String(leftSidebarWidth));
  }, [leftSidebarWidth]);
  useEffect(() => {
    window.localStorage.setItem(STORAGE_RIGHT, String(rightSidebarWidth));
  }, [rightSidebarWidth]);

  // Keyboard shortcuts: Cmd+B = toggle left sidebar, Cmd+Shift+B = toggle right sidebar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (e.shiftKey) {
          setRightSidebarCollapsed((v) => !v);
        } else {
          setLeftSidebarCollapsed((v) => !v);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Derive file context for chat sidebar directly from activePath (stable across loading).
  // Exclude reserved virtual paths (~chats, ~cron, etc.) where file-scoped chat is irrelevant.
  const fileContext = useMemo(() => {
    if (!activePath) {return undefined;}
    if (isVirtualPath(activePath)) {return undefined;}
    const filename = activePath.split("/").pop() || activePath;
    return { path: activePath, filename, isDirectory: content.kind === "directory" };
  }, [activePath, content.kind]);

  // Update content state when the agent edits the file (live reload)
  const handleFileChanged = useCallback((newContent: string) => {
    setContent((prev) => {
      if (prev.kind === "document") {
        return { ...prev, data: { ...prev.data, content: newContent } };
      }
      if (prev.kind === "file" || prev.kind === "code") {
        return { ...prev, data: { ...prev.data, content: newContent } };
      }
      return prev;
    });
  }, []);

  const refreshContext = useCallback(async () => {
    try {
      const res = await fetch("/api/workspace/context");
      const data = await res.json();
      setContext(data);
    } catch {
      // ignore
    }
  }, []);

  // Fetch workspace context on mount
  useEffect(() => {
    void refreshContext();
  }, [refreshContext]);

  // Fetch chat sessions
  const fetchSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const res = await fetch("/api/web-sessions");
      const data = await res.json();
      setSessions(data.sessions ?? []);
    } catch {
      // ignore
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions, sidebarRefreshKey]);

  const refreshSessions = useCallback(() => {
    setSidebarRefreshKey((k) => k + 1);
  }, []);

  const handleProfileChanged = useCallback(() => {
    setBrowseDir(null);
    setActivePath(null);
    setContent({ kind: "none" });
    setChatSidebarPreview(null);
    setShowChatSidebar(true);
    reconnectWorkspaceWatcher();
    refreshSessions();
    void refreshContext();
  }, [reconnectWorkspaceWatcher, refreshContext, refreshSessions, setBrowseDir]);

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      const res = await fetch(`/api/web-sessions/${sessionId}`, { method: "DELETE" });
      if (!res.ok) {return;}
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
        setActiveSubagentKey(null);
        const remaining = sessions.filter((s) => s.id !== sessionId);
        if (remaining.length > 0) {
          const next = remaining[0];
          setActiveSessionId(next.id);
          void chatRef.current?.loadSession(next.id);
        } else {
          void chatRef.current?.newSession();
        }
      }
      void fetchSessions();
    },
    [activeSessionId, sessions, fetchSessions],
  );

  const handleRenameSession = useCallback(
    async (sessionId: string, newTitle: string) => {
      await fetch(`/api/web-sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle }),
      });
      void fetchSessions();
    },
    [fetchSessions],
  );

  // Poll for active (streaming) agent runs so the sidebar can show indicators.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/chat/active");
        if (cancelled) {return;}
        const data = await res.json();
        const ids: string[] = data.sessionIds ?? [];
        setStreamingSessionIds((prev) => {
          // Only update state if the set actually changed (avoid re-renders).
          if (prev.size === ids.length && ids.every((id) => prev.has(id))) {return prev;}
          return new Set(ids);
        });
      } catch {
        // ignore
      }
    };
    void poll();
    const id = setInterval(poll, 3_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Fetch cron jobs for sidebar
  const fetchCronJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/cron/jobs");
      const data: CronJobsResponse = await res.json();
      setCronJobs(data.jobs ?? []);
    } catch {
      // ignore - cron might not be configured
    }
  }, []);

  useEffect(() => {
    void fetchCronJobs();
    const id = setInterval(fetchCronJobs, 30_000);
    return () => clearInterval(id);
  }, [fetchCronJobs]);

  // Load content when path changes
  const loadContent = useCallback(
    async (node: TreeNode) => {
      setActivePath(node.path);
      setContent({ kind: "loading" });

      try {
        if (node.type === "object") {
          const name = objectNameFromPath(node.path);
          const res = await fetch(`/api/workspace/objects/${encodeURIComponent(name)}`);
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            if (errData.code === "DUCKDB_NOT_INSTALLED") {
              setContent({ kind: "duckdb-missing" });
              return;
            }
            setContent({ kind: "none" });
            return;
          }
          const data: ObjectData = await res.json();
          setContent({ kind: "object", data });
        } else if (node.type === "document") {
          // Use virtual-file API for ~skills/ paths
          const res = await fetch(fileApiUrl(node.path));
          if (!res.ok) {
            setContent({ kind: "none" });
            return;
          }
          const data: FileData = await res.json();
          setContent({
            kind: "document",
            data,
            title: node.name.replace(/\.md$/, ""),
          });
        } else if (node.type === "database") {
          setContent({ kind: "database", dbPath: node.path, filename: node.name });
        } else if (node.type === "report") {
          setContent({ kind: "report", reportPath: node.path, filename: node.name });
        } else if (node.type === "file") {
          // Spreadsheet files get their own binary viewer
          if (isSpreadsheetFile(node.name)) {
            const url = rawFileUrl(node.path);
            setContent({ kind: "spreadsheet", url, filename: node.name });
            return;
          }

          // HTML files get an iframe preview
          const ext = node.name.split(".").pop()?.toLowerCase() ?? "";
          if (ext === "html" || ext === "htm") {
            setContent({ kind: "html", rawUrl: rawFileUrl(node.path), contentUrl: fileApiUrl(node.path), filename: node.name });
            return;
          }

          // Check if this is a media file (image/video/audio/pdf)
          const mediaType = detectMediaType(node.name);
          if (mediaType) {
            const url = rawFileUrl(node.path);
            setContent({ kind: "media", url, mediaType, filename: node.name, filePath: node.path });
            return;
          }

          const res = await fetch(fileApiUrl(node.path));
          if (!res.ok) {
            setContent({ kind: "none" });
            return;
          }
          const data: FileData = await res.json();
          // Route code files to the syntax-highlighted CodeViewer
          if (isCodeFile(node.name)) {
            setContent({ kind: "code", data, filename: node.name });
          } else {
            setContent({ kind: "file", data, filename: node.name });
          }
        } else if (node.type === "folder") {
          setContent({ kind: "directory", node });
        }
      } catch {
        setContent({ kind: "none" });
      }
    },
    [],
  );

  const handleNodeSelect = useCallback(
    (node: TreeNode) => {
      // --- Browse-mode: detect special OpenClaw directories ---
      // When the user clicks a known OpenClaw folder while browsing the
      // filesystem, switch back to workspace mode or show the appropriate
      // dashboard instead of showing raw files.
      if (browseDir && isAbsolutePath(node.path)) {
        // Clicking the workspace root → restore full workspace mode
        if (workspaceRoot && node.path === workspaceRoot) {
          setBrowseDir(null);
          return;
        }
        if (openclawDir) {
          // Clicking the cron directory → show cron dashboard
          if (node.path === openclawDir + "/cron") {
            setBrowseDir(null);
            setActivePath("~cron");
            setContent({ kind: "cron-dashboard" });
            return;
          }
          // Clicking any web-chat directory → switch to workspace mode & open chats
          if (openclawDir && node.path.startsWith(openclawDir + "/web-chat")) {
            setBrowseDir(null);
            setActivePath(null);
            setContent({ kind: "none" });
            void chatRef.current?.newSession();
            return;
          }
        }
        // Clicking a folder in browse mode → navigate into it so the tree
        // is fetched fresh, AND show it in the main panel with the chat sidebar.
        // Children come from the live tree (same data source as the sidebar),
        // not from the stale node snapshot.
        if (node.type === "folder") {
          setBrowseDir(node.path);
          setActivePath(node.path);
          setContent({ kind: "directory", node: { name: node.name, path: node.path, type: "folder" } });
          return;
        }
      }

      // --- Virtual path handlers (workspace mode) ---
      // Intercept chat folder item clicks
      if (node.path.startsWith("~chats/")) {
        const sessionId = node.path.slice("~chats/".length);
        setActivePath(null);
        setContent({ kind: "none" });
        setActiveSessionId(sessionId);
        void chatRef.current?.loadSession(sessionId);
        // URL is synced by the activeSessionId effect
        return;
      }
      // Clicking the Chats folder itself opens a new chat
      if (node.path === "~chats") {
        setActivePath(null);
        setContent({ kind: "none" });
        void chatRef.current?.newSession();
        router.replace("/workspace", { scroll: false });
        return;
      }
      // Intercept cron job item clicks
      if (node.path.startsWith("~cron/")) {
        const jobId = node.path.slice("~cron/".length);
        const job = cronJobs.find((j) => j.id === jobId);
        if (job) {
          setActivePath(node.path);
          setContent({ kind: "cron-job", jobId, job });
          router.replace("/workspace", { scroll: false });
          return;
        }
      }
      // Clicking the Cron folder itself opens the dashboard
      if (node.path === "~cron") {
        setActivePath(node.path);
        setContent({ kind: "cron-dashboard" });
        router.replace("/workspace", { scroll: false });
        return;
      }
      void loadContent(node);
    },
    [loadContent, router, cronJobs, browseDir, workspaceRoot, openclawDir, setBrowseDir],
  );

  const loadSidebarPreviewFromNode = useCallback(
    async (node: TreeNode): Promise<SidebarPreviewContent | null> => {
      if (node.type === "folder") {
        return { kind: "directory", path: node.path, name: node.name };
      }
      if (node.type === "database") {
        return { kind: "database", dbPath: node.path, filename: node.name };
      }

      const mediaType = detectMediaType(node.name);
      if (mediaType) {
        return {
          kind: "media",
          url: rawFileUrl(node.path),
          mediaType,
          filename: node.name,
          filePath: node.path,
        };
      }

      const res = await fetch(fileApiUrl(node.path));
      if (!res.ok) {return null;}
      const data: FileData = await res.json();

      if (node.type === "document" || data.type === "markdown") {
        return {
          kind: "document",
          data,
          title: node.name.replace(/\.mdx?$/, ""),
        };
      }
      if (isCodeFile(node.name)) {
        return { kind: "code", data, filename: node.name };
      }
      return { kind: "file", data, filename: node.name };
    },
    [],
  );

  // Open inline file-path mentions from chat.
  // In chat mode, render a Dropbox-style preview in the right sidebar.
  const handleFilePathClickFromChat = useCallback(
    async (rawPath: string) => {
      const inputPath = normalizeChatPath(rawPath);
      if (!inputPath) {return false;}

      // Desktop behavior: always use right-sidebar preview for chat path clicks.
      const shouldPreviewInSidebar = !isMobile;

      const openNode = async (node: TreeNode) => {
        if (!shouldPreviewInSidebar) {
          handleNodeSelect(node);
          setShowChatSidebar(true);
          return true;
        }

        // Ensure we are in main-chat layout so the preview panel is visible.
        if (activePath || content.kind !== "none") {
          setActivePath(null);
          setContent({ kind: "none" });
          router.replace("/workspace", { scroll: false });
        }

        setChatSidebarPreview({
          status: "loading",
          path: node.path,
          filename: node.name,
        });
        const previewContent = await loadSidebarPreviewFromNode(node);
        if (!previewContent) {
          setChatSidebarPreview({
            status: "error",
            path: node.path,
            filename: node.name,
            message: "Could not preview this file.",
          });
          return false;
        }
        setChatSidebarPreview({
          status: "ready",
          path: node.path,
          filename: node.name,
          content: previewContent,
        });
        return true;
      };

      // For workspace-relative paths, prefer the live tree so we preserve semantics.
      if (
        !isAbsolutePath(inputPath) &&
        !isHomeRelativePath(inputPath) &&
        !inputPath.startsWith("./") &&
        !inputPath.startsWith("../")
      ) {
        const node = resolveNode(tree, inputPath);
        if (node) {
          return await openNode(node);
        }
      }

      try {
        const res = await fetch(`/api/workspace/path-info?path=${encodeURIComponent(inputPath)}`);
        if (!res.ok) {return false;}
        const info = await res.json() as {
          path?: string;
          name?: string;
          type?: "file" | "directory" | "other";
        };
        if (!info.path || !info.name || !info.type) {return false;}

        // If this absolute path is inside the current workspace, map it
        // back to a workspace-relative node first.
        if (workspaceRoot && (info.path === workspaceRoot || info.path.startsWith(`${workspaceRoot}/`))) {
          const relPath = info.path === workspaceRoot ? "" : info.path.slice(workspaceRoot.length + 1);
          if (relPath) {
            const node = resolveNode(tree, relPath);
            if (node) {
              return await openNode(node);
            }
          }
        }

        if (info.type === "directory") {
          const dirNode: TreeNode = { name: info.name, path: info.path, type: "folder" };
          if (shouldPreviewInSidebar) {
            return await openNode(dirNode);
          }
          setBrowseDir(info.path);
          setActivePath(info.path);
          setContent({
            kind: "directory",
            node: { name: info.name, path: info.path, type: "folder" },
          });
          setShowChatSidebar(true);
          return true;
        }

        if (info.type === "file") {
          const fileNode: TreeNode = {
            name: info.name,
            path: info.path,
            type: inferNodeTypeFromFileName(info.name),
          };
          if (shouldPreviewInSidebar) {
            return await openNode(fileNode);
          }
          const parentDir = info.path.split("/").slice(0, -1).join("/") || "/";
          if (isAbsolutePath(info.path)) {
            setBrowseDir(parentDir);
          }
          await loadContent(fileNode);
          setShowChatSidebar(true);
          return true;
        }
      } catch {
        // Ignore -- chat message bubble shows inline error state.
      }

      return false;
    },
    [activePath, content.kind, isMobile, tree, handleNodeSelect, workspaceRoot, loadSidebarPreviewFromNode, setBrowseDir, loadContent, router],
  );

  // Build the enhanced tree: real tree + Cron virtual folder at the bottom
  // (Chat sessions live in the right sidebar, not in the tree.)
  // In browse mode, skip virtual folders (they only apply to workspace mode)
  const enhancedTree = useMemo(() => {
    if (browseDir) {
      return tree;
    }

    const cronStatusIcon = (job: CronJob) => {
      if (!job.enabled) {return "\u25CB";} // circle outline
      if (job.state.runningAtMs) {return "\u25CF";} // filled circle
      if (job.state.lastStatus === "error") {return "\u25C6";} // diamond
      if (job.state.lastStatus === "ok") {return "\u2713";} // check
      return "\u25CB";
    };

    const cronChildren: TreeNode[] = cronJobs.map((j) => ({
      name: `${cronStatusIcon(j)} ${j.name}`,
      path: `~cron/${j.id}`,
      type: "file" as const,
      virtual: true,
    }));

    const cronFolder: TreeNode = {
      name: "Cron",
      path: "~cron",
      type: "folder",
      virtual: true,
      children: cronChildren.length > 0 ? cronChildren : undefined,
    };

    return [...tree, cronFolder];
  }, [tree, cronJobs, browseDir]);

  // Compute the effective parentDir for ".." navigation.
  // In browse mode: use browseParentDir from the API.
  // In workspace mode: use the parent of the workspace root (allows escaping workspace).
  const effectiveParentDir = useMemo(() => {
    if (browseDir) {
      return browseParentDir;
    }
    // In workspace mode, allow ".." to go up from workspace root
    if (workspaceRoot) {
      const parent = workspaceRoot === "/" ? null : workspaceRoot.split("/").slice(0, -1).join("/") || "/";
      return parent;
    }
    return null;
  }, [browseDir, browseParentDir, workspaceRoot]);

  // Handle ".." navigation
  const handleNavigateUp = useCallback(() => {
    if (effectiveParentDir != null) {
      setBrowseDir(effectiveParentDir);
    }
  }, [effectiveParentDir, setBrowseDir]);

  // Return to workspace mode
  const handleGoHome = useCallback(() => {
    setBrowseDir(null);
  }, [setBrowseDir]);

  // Navigate to the main chat / home panel
  const handleGoToChat = useCallback(() => {
    setActivePath(null);
    setContent({ kind: "none" });
    router.replace("/workspace", { scroll: false });
  }, [router]);

  // Insert a file mention into the chat editor when a sidebar item is dropped on the chat input.
  // Try the main chat panel first; fall back to the compact (file-scoped) panel.
  const handleSidebarExternalDrop = useCallback((node: TreeNode) => {
    const target = chatRef.current ?? compactChatRef.current;
    target?.insertFileMention?.(node.name, node.path);
  }, []);

  // Handle file search selection: navigate sidebar to the file's location and open it
  const handleFileSearchSelect = useCallback(
    (item: { name: string; path: string; type: string }) => {
      if (item.type === "folder") {
        // Navigate the sidebar into the folder and show it in the main panel.
        // Children come from the live tree (same data source as the sidebar).
        setBrowseDir(item.path);
        setActivePath(item.path);
        setContent({ kind: "directory", node: { name: item.name, path: item.path, type: "folder" } });
      } else {
        // Navigate the sidebar to the parent directory of the file
        const parentOfFile = item.path.split("/").slice(0, -1).join("/") || "/";
        setBrowseDir(parentOfFile);
        // Open the file in the main panel
        const node: TreeNode = {
          name: item.name,
          path: item.path,
          type: item.type as TreeNode["type"],
        };
        void loadContent(node);
      }
    },
    [setBrowseDir, loadContent],
  );

  // Sync URL bar with active content / chat state.
  // Uses window.location instead of searchParams in the comparison to
  // avoid a circular dependency (searchParams updates → effect fires →
  // router.replace → searchParams updates → …).
  useEffect(() => {
    const current = new URLSearchParams(window.location.search);

    if (activePath) {
      // File / content mode — path takes priority over chat.
      if (current.get("path") !== activePath || current.has("chat")) {
        const params = new URLSearchParams();
        params.set("path", activePath);
        const entry = current.get("entry");
        if (entry) {params.set("entry", entry);}
        router.push(`/workspace?${params.toString()}`, { scroll: false });
      }
    } else if (activeSessionId) {
      // Chat mode — no file selected.
      if (current.get("chat") !== activeSessionId || current.has("path")) {
        router.push(`/workspace?chat=${encodeURIComponent(activeSessionId)}`, { scroll: false });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally excludes searchParams to avoid infinite loop
  }, [activePath, activeSessionId, router]);

  // Open entry modal handler
  const handleOpenEntry = useCallback(
    (objectName: string, entryId: string) => {
      setEntryModal({ objectName, entryId });
      const params = new URLSearchParams(searchParams.toString());
      params.set("entry", `${objectName}:${entryId}`);
      router.push(`/workspace?${params.toString()}`, { scroll: false });
    },
    [searchParams, router],
  );

  // Close entry modal handler
  const handleCloseEntry = useCallback(() => {
    setEntryModal(null);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("entry");
    const qs = params.toString();
    router.replace(qs ? `/workspace?${qs}` : "/workspace", { scroll: false });
  }, [searchParams, router]);

  // Auto-navigate to path/chat from URL query params after tree loads
  useEffect(() => {
    if (initialPathHandled.current || treeLoading || tree.length === 0) {return;}

    const pathParam = searchParams.get("path");
    const entryParam = searchParams.get("entry");
    const chatParam = searchParams.get("chat");

    if (pathParam) {
      const node = resolveNode(tree, pathParam);
      if (node) {
        initialPathHandled.current = true;
        void loadContent(node);
      }
    } else if (chatParam) {
      // Restore the active chat session from URL
      initialPathHandled.current = true;
      setActiveSessionId(chatParam);
      setActivePath(null);
      setContent({ kind: "none" });
      void chatRef.current?.loadSession(chatParam);
    }

    // Also open entry modal from URL if present
    if (entryParam && entryParam.includes(":")) {
      const [objName, eid] = entryParam.split(":", 2);
      if (objName && eid) {
        setEntryModal({ objectName: objName, entryId: eid });
      }
    }
  }, [tree, treeLoading, searchParams, loadContent]);

  // Handle ?send= URL parameter: open a new chat session and auto-send the message.
  // Used by the "Install DuckDB" button and similar in-app triggers.
  useEffect(() => {
    const sendParam = searchParams.get("send");
    if (!sendParam) {return;}

    // Clear the send param from the URL immediately
    router.replace("/workspace", { scroll: false });

    // Show the main chat (clear any active file/content)
    setActivePath(null);
    setContent({ kind: "none" });

    // Give ChatPanel a frame to mount, then send the message
    requestAnimationFrame(() => {
      void chatRef.current?.sendNewMessage(sendParam);
    });
  }, [searchParams, router]);

  const handleBreadcrumbNavigate = useCallback(
    (path: string) => {
      if (!path) {
        setActivePath(null);
        setContent({ kind: "none" });
        return;
      }

      // Absolute paths (browse mode): navigate the sidebar directly.
      // Intermediate parent folders aren't in the browse-mode tree, so
      // resolveNode would fail — call setBrowseDir to update the sidebar.
      if (isAbsolutePath(path)) {
        const name = path.split("/").pop() || path;
        setBrowseDir(path);
        setActivePath(path);
        setContent({ kind: "directory", node: { name, path, type: "folder" } });
        return;
      }

      // Relative paths (workspace mode): resolve and navigate via handleNodeSelect
      // so virtual paths, chat context, etc. are all handled properly.
      const node = resolveNode(tree, path);
      if (node) {
        handleNodeSelect(node);
      }
    },
    [tree, handleNodeSelect, setBrowseDir],
  );

  // Navigate to an object by name (used by relation links)
  const handleNavigateToObject = useCallback(
    (objectName: string) => {
      function findObjectNode(nodes: TreeNode[]): TreeNode | null {
        for (const node of nodes) {
          if (node.type === "object" && objectNameFromPath(node.path) === objectName) {
            return node;
          }
          if (node.children) {
            const found = findObjectNode(node.children);
            if (found) {return found;}
          }
        }
        return null;
      }
      const node = findObjectNode(tree);
      if (node) {void loadContent(node);}
    },
    [tree, loadContent],
  );

  /**
   * Unified navigate handler for links in the editor and read mode.
   * Handles /workspace?entry=..., /workspace?path=..., and legacy relative paths.
   */
  const handleEditorNavigate = useCallback(
    (href: string) => {
      // Try parsing as a workspace URL first (/workspace?entry=... or /workspace?path=...)
      const parsed = parseWorkspaceLink(href);
      if (parsed) {
        if (parsed.kind === "entry") {
          handleOpenEntry(parsed.objectName, parsed.entryId);
          return;
        }
        // File/object link -- resolve using the path from the URL
        const node = resolveNode(tree, parsed.path);
        if (node) {
          handleNodeSelect(node);
          return;
        }
      }

      // Fallback: treat as a raw relative path (legacy links)
      const node = resolveNode(tree, href);
      if (node) {
        handleNodeSelect(node);
      }
    },
    [tree, handleNodeSelect, handleOpenEntry],
  );

  // Refresh the currently displayed object (e.g. after changing display field)
  const refreshCurrentObject = useCallback(async () => {
    if (content.kind !== "object") {return;}
    const name = content.data.object.name;
    try {
      const res = await fetch(`/api/workspace/objects/${encodeURIComponent(name)}`);
      if (!res.ok) {return;}
      const data: ObjectData = await res.json();
      setContent({ kind: "object", data });
    } catch {
      // ignore
    }
  }, [content]);

  // Auto-refresh the current object view when the workspace tree updates.
  // The SSE watcher triggers tree refreshes on any file change (including
  // .object.yaml edits by the AI agent). We track the tree reference and
  // re-fetch the object data so saved views/filters update live.
  const prevTreeRef = useRef(tree);
  useEffect(() => {
    if (prevTreeRef.current === tree) {return;}
    prevTreeRef.current = tree;
    if (content.kind === "object") {
      void refreshCurrentObject();
    }
  }, [tree, content.kind, refreshCurrentObject]);

  // Top-level safety net: catch workspace link clicks anywhere in the page
  // to prevent full-page navigation and handle via client-side state instead.
  const handleContainerClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const link = target.closest("a");
      if (!link) {return;}
      const href = link.getAttribute("href");
      if (!href) {return;}
      // Intercept /workspace?... links to handle them in-app
      if (isWorkspaceLink(href)) {
        event.preventDefault();
        event.stopPropagation();
        handleEditorNavigate(href);
      }
    },
    [handleEditorNavigate],
  );

  // Cron navigation handlers
  const handleSelectCronJob = useCallback((jobId: string) => {
    const job = cronJobs.find((j) => j.id === jobId);
    if (job) {
      setActivePath(`~cron/${jobId}`);
      setContent({ kind: "cron-job", jobId, job });
      router.replace("/workspace", { scroll: false });
    }
  }, [cronJobs, router]);

  const handleBackToCronDashboard = useCallback(() => {
    setActivePath("~cron");
    setContent({ kind: "cron-dashboard" });
    router.replace("/workspace", { scroll: false });
  }, [router]);

  // Derive the active session's title for the header / right sidebar
  const activeSessionTitle = useMemo(() => {
    if (!activeSessionId) {return undefined;}
    const s = sessions.find((sess) => sess.id === activeSessionId);
    return s?.title || undefined;
  }, [activeSessionId, sessions]);

  // Whether to show the main ChatPanel (no file/content selected)
  const showMainChat = !activePath || content.kind === "none";

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      ref={layoutRef}
      className="flex h-screen"
      style={{ background: "var(--color-main-bg)" }}
      onClick={handleContainerClick}
    >
      {/* Left sidebar — static on desktop (resizable), drawer overlay on mobile */}
      {isMobile ? (
        sidebarOpen && (
          <WorkspaceSidebar
            tree={enhancedTree}
            activePath={activePath}
            onSelect={(node) => { handleNodeSelect(node); setSidebarOpen(false); }}
            onRefresh={refreshTree}
            orgName={context?.organization?.name}
            loading={treeLoading}
            browseDir={browseDir}
            parentDir={effectiveParentDir}
            onNavigateUp={handleNavigateUp}
            onGoHome={handleGoHome}
            onFileSearchSelect={(item) => { handleFileSearchSelect?.(item); setSidebarOpen(false); }}
            workspaceRoot={workspaceRoot}
            onGoToChat={() => { handleGoToChat(); setSidebarOpen(false); }}
            onExternalDrop={handleSidebarExternalDrop}
            showHidden={showHidden}
            onToggleHidden={() => setShowHidden((v) => !v)}
            activeProfile={workspaceProfile}
            onProfileChanged={handleProfileChanged}
            mobile
            onClose={() => setSidebarOpen(false)}
          />
        )
      ) : (
        <>
          {!leftSidebarCollapsed && (
          <div
            className="flex shrink-0 flex-col relative"
            style={{ width: leftSidebarWidth, minWidth: leftSidebarWidth }}
          >
            <ResizeHandle
              mode="left"
              containerRef={layoutRef}
              min={LEFT_SIDEBAR_MIN}
              max={LEFT_SIDEBAR_MAX}
              onResize={setLeftSidebarWidth}
            />
            <WorkspaceSidebar
              tree={enhancedTree}
              activePath={activePath}
              onSelect={handleNodeSelect}
              onRefresh={refreshTree}
              orgName={context?.organization?.name}
              loading={treeLoading}
              browseDir={browseDir}
              parentDir={effectiveParentDir}
              onNavigateUp={handleNavigateUp}
              onGoHome={handleGoHome}
              onFileSearchSelect={handleFileSearchSelect}
              workspaceRoot={workspaceRoot}
              onGoToChat={handleGoToChat}
              onExternalDrop={handleSidebarExternalDrop}
              showHidden={showHidden}
              onToggleHidden={() => setShowHidden((v) => !v)}
              width={leftSidebarWidth}
              onCollapse={() => setLeftSidebarCollapsed(true)}
              activeProfile={workspaceProfile}
              onProfileChanged={handleProfileChanged}
            />
          </div>
          )}
        </>
      )}

      {/* Expand left sidebar button (shown when collapsed) */}
      {!isMobile && leftSidebarCollapsed && (
        <div className="shrink-0 flex flex-col items-center pt-2.5 px-1.5">
          <button
            type="button"
            onClick={() => setLeftSidebarCollapsed(false)}
            className="p-1.5 rounded-md transition-colors hover:bg-black/5"
            style={{ color: "var(--color-text-muted)" }}
            title="Show sidebar (⌘B)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M9 3v18" />
            </svg>
          </button>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden" style={{ background: "var(--color-main-bg)" }}>
        {/* Mobile top bar — always visible on mobile */}
        {isMobile && (
          <div
            className="px-3 py-2 border-b flex-shrink-0 flex items-center justify-between gap-2"
            style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
          >
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="p-2 rounded-lg flex-shrink-0"
              style={{ color: "var(--color-text-muted)" }}
              title="Open sidebar"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" x2="20" y1="12" y2="12" /><line x1="4" x2="20" y1="6" y2="6" /><line x1="4" x2="20" y1="18" y2="18" />
              </svg>
            </button>
            <div className="flex-1 min-w-0 text-sm font-medium truncate" style={{ color: "var(--color-text)" }}>
              {activePath ? activePath.split("/").pop() : (context?.organization?.name || "Workspace")}
            </div>
            <div className="flex items-center gap-1">
              {activePath && content.kind !== "none" && (
                <button
                  type="button"
                  onClick={() => {
                    setActivePath(null);
                    setContent({ kind: "none" });
                    router.replace("/workspace", { scroll: false });
                  }}
                  className="p-2 rounded-lg flex-shrink-0"
                  style={{ color: "var(--color-text-muted)" }}
                  title="Back to chat"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
                  </svg>
                </button>
              )}
              {showMainChat && (
                <button
                  type="button"
                  onClick={() => setChatSessionsOpen(true)}
                  className="p-2 rounded-lg flex-shrink-0"
                  style={{ color: "var(--color-text-muted)" }}
                  title="Chat sessions"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        )}

        {/* When a file is selected: show top bar with breadcrumbs (desktop only, mobile has unified top bar) */}
        {!isMobile && activePath && content.kind !== "none" && (
          <div
            className="px-6 border-b flex-shrink-0 flex items-center justify-between"
            style={{ borderColor: "var(--color-border)" }}
          >
            <Breadcrumbs
              path={activePath}
              onNavigate={handleBreadcrumbNavigate}
            />
            <div className="flex items-center gap-1">
              {/* Back to chat button */}
              <button
                type="button"
                onClick={() => {
                  setActivePath(null);
                  setContent({ kind: "none" });
                  router.replace("/workspace", { scroll: false });
                }}
                className="p-1.5 rounded-lg flex-shrink-0"
                style={{ color: "var(--color-text-muted)" }}
                title="Back to chat"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
                </svg>
              </button>
              {/* Chat sidebar toggle (hidden for reserved/virtual paths) */}
              {fileContext && (
                <button
                  type="button"
                  onClick={() => setShowChatSidebar((v) => !v)}
                  className="p-1.5 rounded-lg flex-shrink-0"
                  style={{
                    color: showChatSidebar ? "var(--color-accent)" : "var(--color-text-muted)",
                    background: showChatSidebar ? "var(--color-accent-light)" : "transparent",
                  }}
                  title={showChatSidebar ? "Hide chat" : fileContext.isDirectory ? "Chat about this folder" : "Chat about this file"}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Content area */}
        <div className="flex-1 flex min-h-0">
          {showMainChat ? (
            /* Main chat view (default when no file is selected) */
            <>
              <div className="flex-1 flex flex-col min-w-0" style={{ background: "var(--color-main-bg)" }}>
                {activeSubagent ? (
                  <SubagentPanel
                    sessionKey={activeSubagent.childSessionKey}
                    task={activeSubagent.task}
                    label={activeSubagent.label}
                    onBack={handleBackFromSubagent}
                    onSubagentClick={handleSubagentClickFromChat}
                    onFilePathClick={handleFilePathClickFromChat}
                  />
                ) : (
                <ChatPanel
                  ref={chatRef}
                  sessionTitle={activeSessionTitle}
                  initialSessionId={activeSessionId ?? undefined}
                  onActiveSessionChange={(id) => {
                    setActiveSessionId(id);
                    setActiveSubagentKey(null);
                  }}
                  onSessionsChange={refreshSessions}
                  onSubagentSpawned={handleSubagentSpawned}
                  onSubagentClick={handleSubagentClickFromChat}
                  onFilePathClick={handleFilePathClickFromChat}
                  onDeleteSession={handleDeleteSession}
                  onRenameSession={handleRenameSession}
                  compact={isMobile}
                />
                )}
              </div>
              {/* Chat sessions sidebar — static on desktop, drawer overlay on mobile */}
              {isMobile ? (
                chatSessionsOpen && (
                  <ChatSessionsSidebar
                    sessions={sessions}
                    activeSessionId={activeSessionId}
                    activeSessionTitle={activeSessionTitle}
                    streamingSessionIds={streamingSessionIds}
                    subagents={subagents}
                    activeSubagentKey={activeSubagentKey}
                    loading={sessionsLoading}
                    onSelectSession={(sessionId) => {
                      setActiveSessionId(sessionId);
                      setActiveSubagentKey(null);
                      void chatRef.current?.loadSession(sessionId);
                    }}
                    onNewSession={() => {
                      setActiveSessionId(null);
                      setActiveSubagentKey(null);
                      void chatRef.current?.newSession();
                      router.replace("/workspace", { scroll: false });
                      setChatSessionsOpen(false);
                    }}
                    onSelectSubagent={handleSelectSubagent}
                    onDeleteSession={handleDeleteSession}
                    onRenameSession={handleRenameSession}
                    mobile
                    onClose={() => setChatSessionsOpen(false)}
                  />
                )
              ) : (
                <>
                  {!rightSidebarCollapsed && (
                  <div
                    className="flex shrink-0 flex-col relative"
                    style={{ width: rightSidebarWidth, minWidth: rightSidebarWidth, background: "var(--color-sidebar-bg)" }}
                  >
                    <ResizeHandle
                      mode="right"
                      containerRef={layoutRef}
                      min={RIGHT_SIDEBAR_MIN}
                      max={RIGHT_SIDEBAR_MAX}
                      onResize={setRightSidebarWidth}
                    />
                    {chatSidebarPreview ? (
                      <ChatSidebarPreview
                        preview={chatSidebarPreview}
                        onClose={() => setChatSidebarPreview(null)}
                      />
                    ) : (
                      <ChatSessionsSidebar
                        sessions={sessions}
                        activeSessionId={activeSessionId}
                        activeSessionTitle={activeSessionTitle}
                        streamingSessionIds={streamingSessionIds}
                        subagents={subagents}
                        activeSubagentKey={activeSubagentKey}
                        loading={sessionsLoading}
                        onSelectSession={(sessionId) => {
                          setActiveSessionId(sessionId);
                          setActiveSubagentKey(null);
                          void chatRef.current?.loadSession(sessionId);
                        }}
                        onNewSession={() => {
                          setActiveSessionId(null);
                          setActiveSubagentKey(null);
                          void chatRef.current?.newSession();
                          router.replace("/workspace", { scroll: false });
                        }}
                        onSelectSubagent={handleSelectSubagent}
                        onDeleteSession={handleDeleteSession}
                        onRenameSession={handleRenameSession}
                        onCollapse={() => setRightSidebarCollapsed(true)}
                        width={rightSidebarWidth}
                      />
                    )}
                  </div>
                  )}
                  {rightSidebarCollapsed && (
                    <div className="shrink-0 flex flex-col items-center pt-2.5 px-1.5">
                      <button
                        type="button"
                        onClick={() => setRightSidebarCollapsed(false)}
                        className="p-1.5 rounded-md transition-colors hover:bg-black/5"
                        style={{ color: "var(--color-text-muted)" }}
                        title="Show chat sidebar (⌘⇧B)"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect width="18" height="18" x="3" y="3" rx="2" />
                          <path d="M15 3v18" />
                        </svg>
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              {/* File content area */}
              <div className="flex-1 overflow-y-auto">
                <ContentRenderer
                  content={content}
                  workspaceExists={workspaceExists}
                  expectedPath={workspaceRoot}
                  tree={tree}
                  activePath={activePath}
                  browseDir={browseDir}
                  treeLoading={treeLoading}
                  members={context?.members}
                  onNodeSelect={handleNodeSelect}
                  onNavigateToObject={handleNavigateToObject}
                  onRefreshObject={refreshCurrentObject}
                  onRefreshTree={refreshTree}
                  onNavigate={handleEditorNavigate}
                  onOpenEntry={handleOpenEntry}
                  searchFn={searchIndex}
                  onSelectCronJob={handleSelectCronJob}
                  onBackToCronDashboard={handleBackToCronDashboard}
                />
              </div>

              {/* Chat sidebar (file/folder-scoped) — hidden for reserved paths, hidden on mobile */}
              {!isMobile && fileContext && showChatSidebar && !rightSidebarCollapsed && (
                <>
                  <aside
                    className="flex-shrink-0 border-l flex flex-col relative"
                    style={{
                      width: rightSidebarWidth,
                      borderColor: "var(--color-border)",
                      background: "var(--color-bg)",
                    }}
                  >
                    <ResizeHandle
                      mode="right"
                      containerRef={layoutRef}
                      min={RIGHT_SIDEBAR_MIN}
                      max={RIGHT_SIDEBAR_MAX}
                      onResize={setRightSidebarWidth}
                    />
                    <ChatPanel
                      ref={compactChatRef}
                      compact
                      fileContext={fileContext}
                      onFileChanged={handleFileChanged}
                      onFilePathClick={handleFilePathClickFromChat}
                    />
                  </aside>
                </>
              )}
            </>
          )}
        </div>
      </main>

      {/* Entry detail modal (rendered on top of everything) */}
      {entryModal && (
        <EntryDetailModal
          objectName={entryModal.objectName}
          entryId={entryModal.entryId}
          members={context?.members}
          onClose={handleCloseEntry}
          onNavigateEntry={(objName, eid) => handleOpenEntry(objName, eid)}
          onNavigateObject={(objName) => {
            handleCloseEntry();
            handleNavigateToObject(objName);
          }}
          onRefresh={refreshCurrentObject}
        />
      )}
    </div>
  );
}

function previewFileTypeBadge(filename: string): { label: string; color: string } {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") {return { label: "PDF", color: "#ef4444" };}
  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "avif"].includes(ext)) {return { label: "Image", color: "#3b82f6" };}
  if (["mp4", "webm", "mov", "avi", "mkv"].includes(ext)) {return { label: "Video", color: "#8b5cf6" };}
  if (["mp3", "wav", "ogg", "m4a", "aac", "flac"].includes(ext)) {return { label: "Audio", color: "#f59e0b" };}
  if (["md", "mdx"].includes(ext)) {return { label: "Markdown", color: "#10b981" };}
  if (["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "rb", "swift", "kt", "c", "cpp", "h"].includes(ext)) {return { label: ext.toUpperCase(), color: "#3b82f6" };}
  if (["json", "yaml", "yml", "toml", "xml", "csv"].includes(ext)) {return { label: ext.toUpperCase(), color: "#6b7280" };}
  if (["duckdb", "sqlite", "sqlite3", "db"].includes(ext)) {return { label: "Database", color: "#6366f1" };}
  return { label: ext.toUpperCase() || "File", color: "#6b7280" };
}

function shortenPreviewPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

function ChatSidebarPreview({
  preview,
  onClose,
}: {
  preview: ChatSidebarPreviewState;
  onClose: () => void;
}) {
  const badge = previewFileTypeBadge(preview.filename);

  const openInFinder = useCallback(async () => {
    try {
      await fetch("/api/workspace/open-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: preview.path, reveal: true }),
      });
    } catch { /* ignore */ }
  }, [preview.path]);

  const openWithSystem = useCallback(async () => {
    try {
      await fetch("/api/workspace/open-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: preview.path }),
      });
    } catch { /* ignore */ }
  }, [preview.path]);

  const downloadUrl = preview.status === "ready" && preview.content.kind === "media"
    ? preview.content.url
    : null;

  let body: React.ReactNode;

  if (preview.status === "loading") {
    body = (
      <div className="flex flex-col h-full items-center justify-center gap-3">
        <UnicodeSpinner
          name="braille"
          className="text-2xl"
          style={{ color: "var(--color-text-muted)" }}
        />
        <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
          Loading preview...
        </p>
      </div>
    );
  } else if (preview.status === "error") {
    body = (
      <div className="flex flex-col h-full items-center justify-center gap-4 px-6">
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center"
          style={{ background: "color-mix(in srgb, var(--color-error) 10%, transparent)" }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-error)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" x2="9" y1="9" y2="15" />
            <line x1="9" x2="15" y1="9" y2="15" />
          </svg>
        </div>
        <div className="text-center">
          <p className="text-sm font-medium" style={{ color: "var(--color-text)" }}>
            Preview unavailable
          </p>
          <p className="text-xs mt-1" style={{ color: "var(--color-text-muted)" }}>
            {preview.message}
          </p>
        </div>
      </div>
    );
  } else {
    const c = preview.content;
    switch (c.kind) {
      case "media":
        if (c.mediaType === "pdf") {
          // Hide the browser's built-in PDF toolbar for a cleaner look
          const pdfUrl = c.url + (c.url.includes("#") ? "&" : "#") + "toolbar=0&navpanes=0&scrollbar=1";
          body = (
            <iframe
              src={pdfUrl}
              className="w-full h-full"
              style={{ border: "none", colorScheme: "light" }}
              title={`Preview: ${c.filename}`}
            />
          );
        } else if (c.mediaType === "image") {
          body = (
            <div className="flex items-center justify-center h-full p-4 overflow-auto" style={{ background: "var(--color-bg)" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={c.url}
                alt={c.filename}
                className="max-w-full max-h-full object-contain rounded-lg"
                style={{ boxShadow: "0 2px 16px rgba(0,0,0,0.08)" }}
                draggable={false}
              />
            </div>
          );
        } else if (c.mediaType === "video") {
          body = (
            <div className="flex items-center justify-center h-full p-4" style={{ background: "#000" }}>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video src={c.url} controls className="max-w-full max-h-full rounded-lg" />
            </div>
          );
        } else if (c.mediaType === "audio") {
          body = (
            <div className="flex flex-col items-center justify-center h-full gap-6 px-6">
              <div
                className="w-20 h-20 rounded-2xl flex items-center justify-center"
                style={{ background: "linear-gradient(135deg, #f59e0b20, #f59e0b08)" }}
              >
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                </svg>
              </div>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio src={c.url} controls className="w-full" />
            </div>
          );
        }
        break;
      case "document":
        body = (
          <div className="p-5 overflow-auto h-full">
            <div className="workspace-prose text-sm">
              <DocumentView
                content={c.data.content}
                title={c.title}
              />
            </div>
          </div>
        );
        break;
      case "code":
        body = (
          <div className="overflow-auto h-full">
            <CodeViewer content={c.data.content} filename={c.filename} />
          </div>
        );
        break;
      case "file":
        body = (
          <div className="overflow-auto h-full">
            <FileViewer content={c.data.content} filename={c.filename} type={c.data.type === "yaml" ? "yaml" : "text"} />
          </div>
        );
        break;
      case "database":
        body = (
          <div className="overflow-auto h-full">
            <DatabaseViewer dbPath={c.dbPath} filename={c.filename} />
          </div>
        );
        break;
      case "directory":
        body = (
          <div className="flex flex-col items-center justify-center h-full gap-4 px-6">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center"
              style={{ background: "color-mix(in srgb, var(--color-accent) 10%, transparent)" }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
              </svg>
            </div>
            <p className="text-sm font-medium" style={{ color: "var(--color-text)" }}>
              {c.name}
            </p>
          </div>
        );
        break;
      default:
        body = null;
    }
  }

  return (
    <aside
      className="h-full border-l flex flex-col"
      style={{
        borderColor: "var(--color-border)",
        background: "var(--color-bg)",
      }}
    >
      {/* Header: close + filename + badge + actions */}
      <div
        className="px-3 py-2.5 flex items-center gap-2 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md transition-colors flex-shrink-0"
          style={{ color: "var(--color-text-muted)" }}
          title="Close preview"
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18" /><path d="m6 6 12 12" />
          </svg>
        </button>

        <span className="text-[13px] font-medium truncate min-w-0" style={{ color: "var(--color-text)" }}>
          {preview.filename}
        </span>

        <span
          className="text-[10px] font-medium px-1.5 py-[1px] rounded flex-shrink-0"
          style={{
            background: `${badge.color}14`,
            color: badge.color,
          }}
        >
          {badge.label}
        </span>

        <div className="flex items-center gap-0.5 ml-auto flex-shrink-0">
          <button
            type="button"
            onClick={openWithSystem}
            className="p-1.5 rounded-md transition-colors"
            style={{ color: "var(--color-text-muted)" }}
            title="Open with default app"
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </svg>
          </button>
          {downloadUrl && (
            <a
              href={downloadUrl}
              download={preview.filename}
              className="p-1.5 rounded-md transition-colors"
              style={{ color: "var(--color-text-muted)" }}
              title="Download"
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" />
              </svg>
            </a>
          )}
          <button
            type="button"
            onClick={openInFinder}
            className="p-1.5 rounded-md transition-colors"
            style={{ color: "var(--color-text-muted)" }}
            title="Reveal in Finder"
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Preview body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {body}
      </div>

      {/* Footer path */}
      <div
        className="px-3 py-1.5 border-t flex-shrink-0"
        style={{ borderColor: "var(--color-border)" }}
      >
        <p
          className="text-[10px] truncate"
          style={{ color: "var(--color-text-muted)", fontFamily: "'SF Mono', 'Fira Code', monospace" }}
          title={preview.path}
        >
          {shortenPreviewPath(preview.path)}
        </p>
      </div>
    </aside>
  );
}

// --- Content Renderer ---

function ContentRenderer({
  content,
  workspaceExists,
  expectedPath,
  tree,
  activePath,
  browseDir,
  treeLoading,
  members,
  onNodeSelect,
  onNavigateToObject,
  onRefreshObject,
  onRefreshTree,
  onNavigate,
  onOpenEntry,
  searchFn,
  onSelectCronJob,
  onBackToCronDashboard,
}: {
  content: ContentState;
  workspaceExists: boolean;
  expectedPath?: string | null;
  tree: TreeNode[];
  activePath: string | null;
  /** Current browse directory (absolute path), or null in workspace mode. */
  browseDir?: string | null;
  /** Whether the tree is currently being fetched. */
  treeLoading?: boolean;
  members?: Array<{ id: string; name: string; email: string; role: string }>;
  onNodeSelect: (node: TreeNode) => void;
  onNavigateToObject: (objectName: string) => void;
  onRefreshObject: () => void;
  onRefreshTree: () => void;
  onNavigate: (href: string) => void;
  onOpenEntry: (objectName: string, entryId: string) => void;
  searchFn: (query: string, limit?: number) => import("@/lib/search-index").SearchIndexItem[];
  onSelectCronJob: (jobId: string) => void;
  onBackToCronDashboard: () => void;
}) {
  switch (content.kind) {
    case "loading":
      return (
        <div className="flex items-center justify-center h-full">
          <UnicodeSpinner name="braille" className="text-2xl" style={{ color: "var(--color-text-muted)" }} />
        </div>
      );

    case "object":
      return (
        <ObjectView
          data={content.data}
          members={members}
          onNavigateToObject={onNavigateToObject}
          onRefreshObject={onRefreshObject}
          onOpenEntry={onOpenEntry}
        />
      );

    case "document":
      return (
        <DocumentView
          content={content.data.content}
          title={content.title}
          filePath={activePath ?? undefined}
          tree={tree}
          onSave={onRefreshTree}
          onNavigate={onNavigate}
          searchFn={searchFn}
        />
      );

    case "file":
      return (
        <FileViewer
          content={content.data.content}
          filename={content.filename}
          type={content.data.type === "yaml" ? "yaml" : "text"}
        />
      );

    case "code":
      return (
        <CodeViewer
          content={content.data.content}
          filename={content.filename}
        />
      );

    case "media":
      return (
        <MediaViewer
          url={content.url}
          filename={content.filename}
          mediaType={content.mediaType}
          filePath={content.filePath}
        />
      );

    case "spreadsheet":
      return (
        <FileViewer
          filename={content.filename}
          type="spreadsheet"
          url={content.url}
        />
      );

    case "html":
      return (
        <HtmlViewer
          rawUrl={content.rawUrl}
          contentUrl={content.contentUrl}
          filename={content.filename}
        />
      );

    case "database":
      return (
        <DatabaseViewer
          dbPath={content.dbPath}
          filename={content.filename}
        />
      );

    case "report":
      return (
        <ReportViewer
          reportPath={content.reportPath}
        />
      );

    case "directory": {
      // In browse mode the top-level tree is the live listing of browseDir
      // (same data source as the sidebar). Use it directly instead of the
      // possibly-stale node.children stored in content state.
      const isBrowseLive = browseDir != null && activePath === browseDir;
      if (isBrowseLive && treeLoading) {
        return (
          <div className="flex items-center justify-center h-full">
            <UnicodeSpinner name="braille" className="text-2xl" style={{ color: "var(--color-text-muted)" }} />
          </div>
        );
      }
      const directoryNode = isBrowseLive
        ? { ...content.node, children: tree }
        : content.node;
      return (
        <DirectoryListing
          node={directoryNode}
          onNodeSelect={onNodeSelect}
        />
      );
    }

    case "cron-dashboard":
      return (
        <CronDashboard
          onSelectJob={onSelectCronJob}
        />
      );

    case "cron-job":
      return (
        <CronJobDetail
          job={content.job}
          onBack={onBackToCronDashboard}
        />
      );

    case "duckdb-missing":
      return <DuckDBMissing />;

    case "none":
    default:
      if (tree.length === 0) {
        return <EmptyState workspaceExists={workspaceExists} expectedPath={expectedPath} />;
      }
      return <WelcomeView tree={tree} onNodeSelect={onNodeSelect} />;
  }
}

// --- Object View (header + display field selector + table/kanban) ---

function ObjectView({
  data,
  members,
  onNavigateToObject,
  onRefreshObject,
  onOpenEntry,
}: {
  data: ObjectData;
  members?: Array<{ id: string; name: string; email: string; role: string }>;
  onNavigateToObject: (objectName: string) => void;
  onRefreshObject: () => void;
  onOpenEntry?: (objectName: string, entryId: string) => void;
}) {
  const [updatingDisplayField, setUpdatingDisplayField] = useState(false);

  // --- Filter state ---
  const [filters, setFilters] = useState<FilterGroup>(() => emptyFilterGroup());
  const [savedViews, setSavedViews] = useState<SavedView[]>(data.savedViews ?? []);
  const [activeViewName, setActiveViewName] = useState<string | undefined>(data.activeView);

  // --- Server-side pagination state ---
  const [serverPage, setServerPage] = useState(data.page ?? 1);
  const [serverPageSize, setServerPageSize] = useState(data.pageSize ?? 100);
  const [totalCount, setTotalCount] = useState(data.totalCount ?? data.entries.length);
  const [entries, setEntries] = useState(data.entries);
  const [serverSearch, setServerSearch] = useState("");
  const [sortRules, _setSortRules] = useState<SortRule[] | undefined>(undefined);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Column visibility: maps field IDs to boolean (false = hidden)
  const [viewColumns, setViewColumns] = useState<string[] | undefined>(undefined);

  // Convert field-name-based columns list to TanStack VisibilityState keyed by field ID
  const columnVisibility = useMemo(() => {
    if (!viewColumns || viewColumns.length === 0) {return undefined;}
    const vis: Record<string, boolean> = {};
    for (const field of data.fields) {
      vis[field.id] = viewColumns.includes(field.name);
    }
    return vis;
  }, [viewColumns, data.fields]);

  // Fetch entries from server with current pagination/filter/sort/search state
  const fetchEntries = useCallback(async (opts?: {
    page?: number;
    pageSize?: number;
    filters?: FilterGroup;
    sort?: SortRule[];
    search?: string;
  }) => {
    const p = opts?.page ?? serverPage;
    const ps = opts?.pageSize ?? serverPageSize;
    const f = opts?.filters ?? filters;
    const s = opts?.sort ?? sortRules;
    const q = opts?.search ?? serverSearch;

    const params = new URLSearchParams();
    params.set("page", String(p));
    params.set("pageSize", String(ps));
    if (f && f.rules.length > 0) {
      params.set("filters", serializeFilters(f));
    }
    if (s && s.length > 0) {
      params.set("sort", JSON.stringify(s));
    }
    if (q) {
      params.set("search", q);
    }

    try {
      const res = await fetch(
        `/api/workspace/objects/${encodeURIComponent(data.object.name)}?${params.toString()}`
      );
      if (!res.ok) {return;}
      const result: ObjectData = await res.json();
      setEntries(result.entries);
      setTotalCount(result.totalCount ?? result.entries.length);
      setServerPage(result.page ?? p);
      setServerPageSize(result.pageSize ?? ps);
    } catch {
      // ignore
    }
  }, [serverPage, serverPageSize, filters, sortRules, serverSearch, data.object.name]);

  // Sync initial data from props (when parent refreshes via SSE)
  useEffect(() => {
    setEntries(data.entries);
    setTotalCount(data.totalCount ?? data.entries.length);
  }, [data.entries, data.totalCount]);

  // Sync saved views when data changes (e.g. SSE refresh from AI editing .object.yaml)
  useEffect(() => {
    setSavedViews(data.savedViews ?? []);

    const decision = resolveActiveViewSyncDecision({
      savedViews: data.savedViews,
      activeView: data.activeView,
      currentActiveViewName: activeViewName,
      currentFilters: filters,
      currentViewColumns: viewColumns,
    });
    if (decision?.shouldApply) {
      setFilters(decision.nextFilters);
      setViewColumns(decision.nextColumns);
      setActiveViewName(decision.nextActiveViewName);
      // Re-fetch with filters from the synchronized active view.
      void fetchEntries({ page: 1, filters: decision.nextFilters });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.savedViews, data.activeView]);

  // When filters change, reset to page 1 and re-fetch
  const handleFiltersChange = useCallback((newFilters: FilterGroup) => {
    setFilters(newFilters);
    setServerPage(1);
    void fetchEntries({ page: 1, filters: newFilters });
  }, [fetchEntries]);

  // Server-side search with debounce
  const handleServerSearch = useCallback((query: string) => {
    setServerSearch(query);
    if (searchTimerRef.current) {clearTimeout(searchTimerRef.current);}
    searchTimerRef.current = setTimeout(() => {
      setServerPage(1);
      void fetchEntries({ page: 1, search: query });
    }, 300);
  }, [fetchEntries]);

  // Page change
  const handlePageChange = useCallback((page: number) => {
    setServerPage(page);
    void fetchEntries({ page });
  }, [fetchEntries]);

  // Page size change
  const handlePageSizeChange = useCallback((size: number) => {
    setServerPageSize(size);
    setServerPage(1);
    void fetchEntries({ page: 1, pageSize: size });
  }, [fetchEntries]);

  // Override onRefreshObject to re-fetch with current pagination state
  const handleRefresh = useCallback(() => {
    void fetchEntries();
    onRefreshObject();
  }, [fetchEntries, onRefreshObject]);

  // Use entries from server (already filtered server-side)
  const filteredEntries = entries;

  // Save view to .object.yaml via API
  const handleSaveView = useCallback(async (name: string) => {
    const newView: SavedView = { name, filters, columns: viewColumns };
    const updated = [...savedViews.filter((v) => v.name !== name), newView];
    setSavedViews(updated);
    setActiveViewName(name);
    try {
      await fetch(
        `/api/workspace/objects/${encodeURIComponent(data.object.name)}/views`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ views: updated, activeView: name }),
        },
      );
    } catch {
      // ignore save errors
    }
  }, [filters, savedViews, data.object.name]);

  const handleLoadView = useCallback((view: SavedView) => {
    const newFilters = view.filters ?? emptyFilterGroup();
    setFilters(newFilters);
    setViewColumns(view.columns);
    setActiveViewName(view.name);
    setServerPage(1);
    void fetchEntries({ page: 1, filters: newFilters });
  }, [fetchEntries]);

  const handleDeleteView = useCallback(async (name: string) => {
    const updated = savedViews.filter((v) => v.name !== name);
    setSavedViews(updated);
    if (activeViewName === name) {
      setActiveViewName(undefined);
      setFilters(emptyFilterGroup());
      setViewColumns(undefined);
    }
    try {
      await fetch(
        `/api/workspace/objects/${encodeURIComponent(data.object.name)}/views`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            views: updated,
            activeView: activeViewName === name ? undefined : activeViewName,
          }),
        },
      );
    } catch {
      // ignore
    }
  }, [savedViews, activeViewName, data.object.name]);

  const handleSetActiveView = useCallback(async (name: string | undefined) => {
    setActiveViewName(name);
    if (!name) {setViewColumns(undefined);}
    try {
      await fetch(
        `/api/workspace/objects/${encodeURIComponent(data.object.name)}/views`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ views: savedViews, activeView: name }),
        },
      );
    } catch {
      // ignore
    }
  }, [savedViews, data.object.name]);

  const handleDisplayFieldChange = async (fieldName: string) => {
    setUpdatingDisplayField(true);
    try {
      const res = await fetch(
        `/api/workspace/objects/${encodeURIComponent(data.object.name)}/display-field`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayField: fieldName }),
        },
      );
      if (res.ok) {
        onRefreshObject();
      }
    } catch {
      // ignore
    } finally {
      setUpdatingDisplayField(false);
    }
  };

  const displayFieldCandidates = data.fields.filter(
    (f) => !["relation", "boolean", "richtext"].includes(f.type),
  );

  const hasRelationFields = data.fields.some((f) => f.type === "relation");
  const hasReverseRelations =
    data.reverseRelations && data.reverseRelations.some(
      (rr) => Object.keys(rr.entries).length > 0,
    );

  const filterBarMembers = useMemo(
    () => members?.map((m) => ({ id: m.id, name: m.name })),
    [members],
  );

  return (
    <div className="p-6">
      {/* Object header */}
      <div className="mb-4">
        <h1
          className="font-instrument text-3xl tracking-tight capitalize"
          style={{ color: "var(--color-text)" }}
        >
          {data.object.name}
        </h1>
        {data.object.description && (
          <p
            className="text-sm mt-1"
            style={{ color: "var(--color-text-muted)" }}
          >
            {data.object.description}
          </p>
        )}
        <div className="flex items-center gap-3 mt-3 flex-wrap">
          <span
            className="text-xs px-2 py-1 rounded-full"
            style={{
              background: "var(--color-surface)",
              color: "var(--color-text-muted)",
              border: "1px solid var(--color-border)",
            }}
          >
            {totalCount} entries
          </span>
          <span
            className="text-xs px-2 py-1 rounded-full"
            style={{
              background: "var(--color-surface)",
              color: "var(--color-text-muted)",
              border: "1px solid var(--color-border)",
            }}
          >
            {data.fields.length} fields
          </span>

          {hasRelationFields && (
            <span
              className="text-xs px-2 py-1 rounded-full"
              style={{
                background: "var(--color-chip-document)",
                color: "var(--color-chip-document-text)",
                border: "1px solid var(--color-border)",
              }}
            >
              {data.fields.filter((f) => f.type === "relation").length} relation{data.fields.filter((f) => f.type === "relation").length !== 1 ? "s" : ""}
            </span>
          )}
          {hasReverseRelations && (
            <span
              className="text-xs px-2 py-1 rounded-full"
              style={{
                background: "var(--color-chip-database)",
                color: "var(--color-chip-database-text)",
                border: "1px solid var(--color-border)",
              }}
            >
              {data.reverseRelations!.filter((rr) => Object.keys(rr.entries).length > 0).length} linked from
            </span>
          )}
        </div>

        {displayFieldCandidates.length > 0 && (
          <div className="flex items-center gap-2 mt-3">
            <span
              className="text-xs"
              style={{ color: "var(--color-text-muted)" }}
            >
              Display field:
            </span>
            <select
              value={data.effectiveDisplayField ?? ""}
              onChange={(e) => handleDisplayFieldChange(e.target.value)}
              disabled={updatingDisplayField}
              className="text-xs px-2 py-1 rounded-md outline-none transition-colors cursor-pointer"
              style={{
                background: "var(--color-surface)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border)",
                opacity: updatingDisplayField ? 0.5 : 1,
              }}
            >
              {displayFieldCandidates.map((f) => (
                <option key={f.id} value={f.name}>
                  {f.name}
                </option>
              ))}
            </select>
            {updatingDisplayField && (
              <div
                className="w-3 h-3 border border-t-transparent rounded-full animate-spin"
                style={{ borderColor: "var(--color-text-muted)" }}
              />
            )}
            <span
              className="text-[10px]"
              style={{ color: "var(--color-text-muted)", opacity: 0.6 }}
            >
              Used when other objects link here
            </span>
          </div>
        )}
      </div>

      {/* Filter bar */}
      <div
        className="mb-4 py-3 px-4 rounded-lg border"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface)",
        }}
      >
        <ObjectFilterBar
          fields={data.fields}
          filters={filters}
          onFiltersChange={handleFiltersChange}
          savedViews={savedViews}
          activeViewName={activeViewName}
          onSaveView={handleSaveView}
          onLoadView={handleLoadView}
          onDeleteView={handleDeleteView}
          onSetActiveView={handleSetActiveView}
          members={filterBarMembers}
        />
      </div>

      {/* Table or Kanban */}
      {data.object.default_view === "kanban" ? (
        <ObjectKanban
          objectName={data.object.name}
          fields={data.fields}
          entries={filteredEntries}
          statuses={data.statuses}
          members={members}
          relationLabels={data.relationLabels}
          onEntryClick={onOpenEntry ? (entryId) => onOpenEntry(data.object.name, entryId) : undefined}
          onRefresh={handleRefresh}
        />
      ) : (
        <ObjectTable
          objectName={data.object.name}
          fields={data.fields}
          entries={filteredEntries}
          members={members}
          relationLabels={data.relationLabels}
          reverseRelations={data.reverseRelations}
          onNavigateToObject={onNavigateToObject}
          onEntryClick={onOpenEntry ? (entryId) => onOpenEntry(data.object.name, entryId) : undefined}
          onRefresh={handleRefresh}
          columnVisibility={columnVisibility}
          serverPagination={{
            totalCount,
            page: serverPage,
            pageSize: serverPageSize,
            onPageChange: handlePageChange,
            onPageSizeChange: handlePageSizeChange,
          }}
          onServerSearch={handleServerSearch}
        />
      )}
    </div>
  );
}

// --- Directory Listing ---

function DirectoryListing({
  node,
  onNodeSelect,
}: {
  node: TreeNode;
  onNodeSelect: (node: TreeNode) => void;
}) {
  const children = node.children ?? [];

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1
        className="font-instrument text-3xl tracking-tight mb-1 capitalize"
        style={{ color: "var(--color-text)" }}
      >
        {node.name}
      </h1>
      <p className="text-sm mb-6" style={{ color: "var(--color-text-muted)" }}>
        {children.length} items
      </p>

      {children.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
          This folder is empty.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {children.map((child) => (
            <button
              type="button"
              key={child.path}
              onClick={() => onNodeSelect(child)}
              className="flex items-center gap-3 p-4 rounded-2xl text-left transition-all duration-100 cursor-pointer"
              style={{
                background: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                boxShadow: "var(--shadow-sm)",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor =
                  "var(--color-border-strong)";
                (e.currentTarget as HTMLElement).style.transform = "translateY(-1px)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor =
                  "var(--color-border)";
                (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
              }}
            >
              <span
                className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{
                  background:
                    child.type === "object"
                      ? "var(--color-chip-object)"
                      : child.type === "document"
                        ? "var(--color-chip-document)"
                        : child.type === "database"
                          ? "var(--color-chip-database)"
                          : child.type === "report"
                            ? "var(--color-chip-report)"
                            : "var(--color-surface-hover)",
                  color:
                    child.type === "object"
                      ? "var(--color-chip-object-text)"
                      : child.type === "document"
                        ? "var(--color-chip-document-text)"
                        : child.type === "database"
                          ? "var(--color-chip-database-text)"
                          : child.type === "report"
                            ? "var(--color-chip-report-text)"
                            : "var(--color-text-muted)",
                }}
              >
                <NodeTypeIcon type={child.type} />
              </span>
              <div className="min-w-0 flex-1">
                <div
                  className="text-sm font-medium truncate"
                  style={{ color: "var(--color-text)" }}
                >
                  {child.name.replace(/\.md$/, "")}
                </div>
                <div
                  className="text-xs capitalize"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {child.type}
                  {child.children ? ` (${child.children.length})` : ""}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Welcome View (no selection) ---

function WelcomeView({
  tree,
  onNodeSelect,
}: {
  tree: TreeNode[];
  onNodeSelect: (node: TreeNode) => void;
}) {
  const objects: TreeNode[] = [];
  const documents: TreeNode[] = [];

  function collect(nodes: TreeNode[]) {
    for (const n of nodes) {
      if (n.type === "object") {objects.push(n);}
      else if (n.type === "document") {documents.push(n);}
      if (n.children) {collect(n.children);}
    }
  }
  collect(tree);

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1
        className="font-instrument text-3xl tracking-tight mb-2"
        style={{ color: "var(--color-text)" }}
      >
        Workspace
      </h1>
      <p className="text-sm mb-8" style={{ color: "var(--color-text-muted)" }}>
        Select an item from the sidebar, or browse the sections below.
      </p>

      {objects.length > 0 && (
        <div className="mb-8">
          <h2
            className="text-sm font-medium uppercase tracking-wider mb-3"
            style={{ color: "var(--color-text-muted)" }}
          >
            Objects
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {objects.map((obj) => (
              <button
                type="button"
                key={obj.path}
                onClick={() => onNodeSelect(obj)}
                className="flex items-center gap-3 p-4 rounded-2xl text-left transition-all duration-100 cursor-pointer"
                style={{
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                  boxShadow: "var(--shadow-sm)",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor =
                    "var(--color-accent)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor =
                    "var(--color-border)";
                }}
              >
                <span
                  className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{
                    background: "var(--color-chip-object)",
                    color: "var(--color-chip-object-text)",
                  }}
                >
                  <NodeTypeIcon type="object" />
                </span>
                <div className="min-w-0">
                  <div
                    className="text-sm font-medium capitalize truncate"
                    style={{ color: "var(--color-text)" }}
                  >
                    {obj.name}
                  </div>
                  <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                    {obj.defaultView === "kanban" ? "Kanban board" : "Table view"}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {documents.length > 0 && (
        <div>
          <h2
            className="text-sm font-medium uppercase tracking-wider mb-3"
            style={{ color: "var(--color-text-muted)" }}
          >
            Documents
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {documents.map((doc) => (
              <button
                type="button"
                key={doc.path}
                onClick={() => onNodeSelect(doc)}
                className="flex items-center gap-3 p-4 rounded-2xl text-left transition-all duration-100 cursor-pointer"
                style={{
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                  boxShadow: "var(--shadow-sm)",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor = "var(--color-chip-document-text)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor =
                    "var(--color-border)";
                }}
              >
                <span
                  className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{
                    background: "var(--color-chip-document)",
                    color: "var(--color-chip-document-text)",
                  }}
                >
                  <NodeTypeIcon type="document" />
                </span>
                <div className="min-w-0">
                  <div
                    className="text-sm font-medium truncate"
                    style={{ color: "var(--color-text)" }}
                  >
                    {doc.name.replace(/\.md$/, "")}
                  </div>
                  <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                    Document
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Shared icon for node types ---

function NodeTypeIcon({ type }: { type: string }) {
  switch (type) {
    case "object":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v18" /><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" />
        </svg>
      );
    case "document":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" />
        </svg>
      );
    case "folder":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
      );
    case "database":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5V19A9 3 0 0 0 21 19V5" />
          <path d="M3 12A9 3 0 0 0 21 12" />
        </svg>
      );
    case "report":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" x2="12" y1="20" y2="10" />
          <line x1="18" x2="18" y1="20" y2="4" />
          <line x1="6" x2="6" y1="20" y2="14" />
        </svg>
      );
    default:
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" />
        </svg>
      );
  }
}
