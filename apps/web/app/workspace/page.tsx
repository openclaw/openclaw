"use client";

import { Suspense, useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { WorkspaceSidebar } from "../components/workspace/workspace-sidebar";
import { type TreeNode } from "../components/workspace/file-manager-tree";
import { useWorkspaceWatcher } from "../hooks/use-workspace-watcher";
import { ObjectTable } from "../components/workspace/object-table";
import { ObjectKanban } from "../components/workspace/object-kanban";
import { DocumentView } from "../components/workspace/document-view";
import { FileViewer } from "../components/workspace/file-viewer";
import { CodeViewer } from "../components/workspace/code-viewer";
import { MediaViewer, detectMediaType, type MediaType } from "../components/workspace/media-viewer";
import { DatabaseViewer, DuckDBMissing } from "../components/workspace/database-viewer";
import { Breadcrumbs } from "../components/workspace/breadcrumbs";
import { ChatSessionsSidebar } from "../components/workspace/chat-sessions-sidebar";
import { EmptyState } from "../components/workspace/empty-state";
import { ReportViewer } from "../components/charts/report-viewer";
import { ChatPanel, type ChatPanelHandle } from "../components/chat-panel";
import { EntryDetailModal } from "../components/workspace/entry-detail-modal";
import { useSearchIndex } from "@/lib/search-index";
import { parseWorkspaceLink, isWorkspaceLink } from "@/lib/workspace-links";
import { isCodeFile } from "@/lib/report-utils";
import { CronDashboard } from "../components/cron/cron-dashboard";
import { CronJobDetail } from "../components/cron/cron-job-detail";
import type { CronJob, CronJobsResponse } from "../types/cron";

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
  | { kind: "database"; dbPath: string; filename: string }
  | { kind: "report"; reportPath: string; filename: string }
  | { kind: "directory"; node: TreeNode }
  | { kind: "cron-dashboard" }
  | { kind: "cron-job"; jobId: string; job: CronJob }
  | { kind: "duckdb-missing" };

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
  return path.startsWith("~");
}

/** Detect absolute filesystem paths (browse mode). */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/");
}

/** Pick the right file API endpoint based on virtual vs real vs absolute paths. */
function fileApiUrl(path: string): string {
  if (isVirtualPath(path)) {
    return `/api/workspace/virtual-file?path=${encodeURIComponent(path)}`;
  }
  if (isAbsolutePath(path)) {
    return `/api/workspace/browse-file?path=${encodeURIComponent(path)}`;
  }
  return `/api/workspace/file?path=${encodeURIComponent(path)}`;
}

/** Pick the right raw file URL for media preview. */
function rawFileUrl(path: string): string {
  if (isAbsolutePath(path)) {
    return `/api/workspace/browse-file?path=${encodeURIComponent(path)}&raw=true`;
  }
  return `/api/workspace/raw-file?path=${encodeURIComponent(path)}`;
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
        <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }} />
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

  // Live-reactive tree via SSE watcher (with browse-mode support)
  const {
    tree, loading: treeLoading, exists: workspaceExists, refresh: refreshTree,
    browseDir, setBrowseDir, parentDir: browseParentDir, workspaceRoot, openclawDir,
  } = useWorkspaceWatcher();

  // Search index for @ mention fuzzy search (files + entries)
  const { search: searchIndex } = useSearchIndex();

  const [context, setContext] = useState<WorkspaceContext | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState<ContentState>({ kind: "none" });
  const [showChatSidebar, setShowChatSidebar] = useState(true);

  // Chat session state
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<WebSession[]>([]);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  const [streamingSessionIds, setStreamingSessionIds] = useState<Set<string>>(new Set());

  // Cron jobs state
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);

  // Entry detail modal state
  const [entryModal, setEntryModal] = useState<{
    objectName: string;
    entryId: string;
  } | null>(null);

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

  // Fetch workspace context on mount
  useEffect(() => {
    let cancelled = false;
    async function loadContext() {
      try {
        const res = await fetch("/api/workspace/context");
        const data = await res.json();
        if (!cancelled) {setContext(data);}
      } catch {
        // ignore
      }
    }
    void loadContext();
    return () => { cancelled = true; };
  }, []);

  // Fetch chat sessions
  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/web-sessions");
      const data = await res.json();
      setSessions(data.sessions ?? []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions, sidebarRefreshKey]);

  const refreshSessions = useCallback(() => {
    setSidebarRefreshKey((k) => k + 1);
  }, []);

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
          // Clicking the web-chat directory → switch to workspace mode & open chats
          if (node.path === openclawDir + "/web-chat") {
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

  // Insert a file mention into the chat editor when a sidebar item is dropped on the chat input
  const handleSidebarExternalDrop = useCallback((node: TreeNode) => {
    chatRef.current?.insertFileMention?.(node.name, node.path);
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
        router.replace(`/workspace?${params.toString()}`, { scroll: false });
      }
    } else if (activeSessionId) {
      // Chat mode — no file selected.
      if (current.get("chat") !== activeSessionId || current.has("path")) {
        router.replace(`/workspace?chat=${encodeURIComponent(activeSessionId)}`, { scroll: false });
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
      router.replace(`/workspace?${params.toString()}`, { scroll: false });
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
    const s = sessions.find((s) => s.id === activeSessionId);
    return s?.title || undefined;
  }, [activeSessionId, sessions]);

  // Whether to show the main ChatPanel (no file/content selected)
  const showMainChat = !activePath || content.kind === "none";

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className="flex h-screen" style={{ background: "var(--color-bg)" }} onClick={handleContainerClick}>
      {/* Sidebar */}
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
      />

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* When a file is selected: show top bar with breadcrumbs */}
        {activePath && content.kind !== "none" && (
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
              <div className="flex-1 flex flex-col min-w-0">
                <ChatPanel
                  ref={chatRef}
                  sessionTitle={activeSessionTitle}
                  initialSessionId={activeSessionId ?? undefined}
                  onActiveSessionChange={(id) => {
                    setActiveSessionId(id);
                  }}
                  onSessionsChange={refreshSessions}
                />
              </div>
              <ChatSessionsSidebar
                sessions={sessions}
                activeSessionId={activeSessionId}
                activeSessionTitle={activeSessionTitle}
                streamingSessionIds={streamingSessionIds}
                onSelectSession={(sessionId) => {
                  setActiveSessionId(sessionId);
                  void chatRef.current?.loadSession(sessionId);
                }}
                onNewSession={() => {
                  setActiveSessionId(null);
                  void chatRef.current?.newSession();
                  router.replace("/workspace", { scroll: false });
                }}
              />
            </>
          ) : (
            <>
              {/* File content area */}
              <div className="flex-1 overflow-y-auto">
                <ContentRenderer
                  content={content}
                  workspaceExists={workspaceExists}
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

              {/* Chat sidebar (file/folder-scoped) — hidden for reserved paths */}
              {fileContext && showChatSidebar && (
                <aside
                  className="flex-shrink-0 border-l"
                  style={{
                    width: 380,
                    borderColor: "var(--color-border)",
                    background: "var(--color-bg)",
                  }}
                >
                  <ChatPanel
                    compact
                    fileContext={fileContext}
                    onFileChanged={handleFileChanged}
                  />
                </aside>
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

// --- Content Renderer ---

function ContentRenderer({
  content,
  workspaceExists,
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
          <div
            className="w-6 h-6 border-2 rounded-full animate-spin"
            style={{
              borderColor: "var(--color-border)",
              borderTopColor: "var(--color-accent)",
            }}
          />
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
            <div
              className="w-6 h-6 border-2 rounded-full animate-spin"
              style={{
                borderColor: "var(--color-border)",
                borderTopColor: "var(--color-accent)",
              }}
            />
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
        return <EmptyState workspaceExists={workspaceExists} />;
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

  return (
    <div className="p-6">
      {/* Object header */}
      <div className="mb-6">
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
            {data.entries.length} entries
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

      {/* Table or Kanban */}
      {data.object.default_view === "kanban" ? (
        <ObjectKanban
          objectName={data.object.name}
          fields={data.fields}
          entries={data.entries}
          statuses={data.statuses}
          members={members}
          relationLabels={data.relationLabels}
          onEntryClick={onOpenEntry ? (entryId) => onOpenEntry(data.object.name, entryId) : undefined}
          onRefresh={onRefreshObject}
        />
      ) : (
        <ObjectTable
          objectName={data.object.name}
          fields={data.fields}
          entries={data.entries}
          members={members}
          relationLabels={data.relationLabels}
          reverseRelations={data.reverseRelations}
          onNavigateToObject={onNavigateToObject}
          onEntryClick={onOpenEntry ? (entryId) => onOpenEntry(data.object.name, entryId) : undefined}
          onRefresh={onRefreshObject}
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
