"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { WorkspaceSidebar } from "../components/workspace/workspace-sidebar";
import { type TreeNode } from "../components/workspace/file-manager-tree";
import { useWorkspaceWatcher } from "../hooks/use-workspace-watcher";
import { ObjectTable } from "../components/workspace/object-table";
import { ObjectKanban } from "../components/workspace/object-kanban";
import { DocumentView } from "../components/workspace/document-view";
import { FileViewer } from "../components/workspace/file-viewer";
import { DatabaseViewer } from "../components/workspace/database-viewer";
import { Breadcrumbs } from "../components/workspace/breadcrumbs";
import { EmptyState } from "../components/workspace/empty-state";
import { ReportViewer } from "../components/charts/report-viewer";
import { ChatPanel } from "../components/chat-panel";

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
  type: "markdown" | "yaml" | "text";
};

type ContentState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "object"; data: ObjectData }
  | { kind: "document"; data: FileData; title: string }
  | { kind: "file"; data: FileData; filename: string }
  | { kind: "database"; dbPath: string; filename: string }
  | { kind: "report"; reportPath: string; filename: string }
  | { kind: "directory"; node: TreeNode };

// --- Helpers ---

/** Find a node in the tree by path. */
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

// --- Main Page ---

export default function WorkspacePage() {
  const searchParams = useSearchParams();
  const initialPathHandled = useRef(false);

  // Live-reactive tree via SSE watcher
  const { tree, loading: treeLoading, exists: workspaceExists, refresh: refreshTree } = useWorkspaceWatcher();

  const [context, setContext] = useState<WorkspaceContext | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState<ContentState>({ kind: "none" });
  const [showChatSidebar, setShowChatSidebar] = useState(true);

  // Derive file context for chat sidebar directly from activePath (stable across loading)
  const fileContext = useMemo(() => {
    if (!activePath) {return undefined;}
    const filename = activePath.split("/").pop() || activePath;
    return { path: activePath, filename };
  }, [activePath]);

  // Update content state when the agent edits the file (live reload)
  const handleFileChanged = useCallback((newContent: string) => {
    setContent((prev) => {
      if (prev.kind === "document") {
        return { ...prev, data: { ...prev.data, content: newContent } };
      }
      if (prev.kind === "file") {
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
    loadContext();
    return () => { cancelled = true; };
  }, []);

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
            setContent({ kind: "none" });
            return;
          }
          const data: ObjectData = await res.json();
          setContent({ kind: "object", data });
        } else if (node.type === "document") {
          const res = await fetch(
            `/api/workspace/file?path=${encodeURIComponent(node.path)}`,
          );
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
          const res = await fetch(
            `/api/workspace/file?path=${encodeURIComponent(node.path)}`,
          );
          if (!res.ok) {
            setContent({ kind: "none" });
            return;
          }
          const data: FileData = await res.json();
          setContent({ kind: "file", data, filename: node.name });
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
      loadContent(node);
    },
    [loadContent],
  );

  // Auto-navigate to path from URL query param after tree loads
  useEffect(() => {
    if (initialPathHandled.current || treeLoading || tree.length === 0) {return;}

    const pathParam = searchParams.get("path");
    if (pathParam) {
      const node = findNode(tree, pathParam);
      if (node) {
        initialPathHandled.current = true;
        loadContent(node);
      }
    }
  }, [tree, treeLoading, searchParams, loadContent]);

  const handleBreadcrumbNavigate = useCallback(
    (path: string) => {
      if (!path) {
        setActivePath(null);
        setContent({ kind: "none" });
        return;
      }
      const node = findNode(tree, path);
      if (node) {
        loadContent(node);
      }
    },
    [tree, loadContent],
  );

  // Navigate to an object by name (used by relation links)
  const handleNavigateToObject = useCallback(
    (objectName: string) => {
      // Find the object node in the tree
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
      if (node) {loadContent(node);}
    },
    [tree, loadContent],
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

  return (
    <div className="flex h-screen" style={{ background: "var(--color-bg)" }}>
      {/* Sidebar */}
      <WorkspaceSidebar
        tree={tree}
        activePath={activePath}
        onSelect={handleNodeSelect}
        onRefresh={refreshTree}
        orgName={context?.organization?.name}
        loading={treeLoading}
      />

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar with breadcrumbs */}
        {activePath && (
          <div
            className="px-6 border-b flex-shrink-0 flex items-center justify-between"
            style={{ borderColor: "var(--color-border)" }}
          >
            <Breadcrumbs
              path={activePath}
              onNavigate={handleBreadcrumbNavigate}
            />
            {/* Chat sidebar toggle */}
            <button
              type="button"
              onClick={() => setShowChatSidebar((v) => !v)}
              className="p-1.5 rounded-md transition-colors flex-shrink-0"
              style={{
                color: showChatSidebar ? "var(--color-accent)" : "var(--color-text-muted)",
                background: showChatSidebar ? "rgba(232, 93, 58, 0.1)" : "transparent",
              }}
              title={showChatSidebar ? "Hide chat" : "Chat about this file"}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          </div>
        )}

        {/* Content + Chat sidebar row */}
        <div className="flex-1 flex min-h-0">
          {/* Content area */}
          <div className="flex-1 overflow-y-auto">
            <ContentRenderer
              content={content}
              workspaceExists={workspaceExists}
              tree={tree}
              activePath={activePath}
              members={context?.members}
              onNodeSelect={handleNodeSelect}
              onNavigateToObject={handleNavigateToObject}
              onRefreshObject={refreshCurrentObject}
              onRefreshTree={refreshTree}
            />
          </div>

          {/* Chat sidebar (file-scoped) */}
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
        </div>
      </main>
    </div>
  );
}

// --- Content Renderer ---

function ContentRenderer({
  content,
  workspaceExists,
  tree,
  activePath,
  members,
  onNodeSelect,
  onNavigateToObject,
  onRefreshObject,
  onRefreshTree,
}: {
  content: ContentState;
  workspaceExists: boolean;
  tree: TreeNode[];
  activePath: string | null;
  members?: Array<{ id: string; name: string; email: string; role: string }>;
  onNodeSelect: (node: TreeNode) => void;
  onNavigateToObject: (objectName: string) => void;
  onRefreshObject: () => void;
  onRefreshTree: () => void;
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
          onNavigate={(path) => {
            // Find the node in the tree and navigate to it
            const node = findNode(tree, path);
            if (node) {
              onNodeSelect(node);
            }
          }}
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

    case "directory":
      return (
        <DirectoryListing
          node={content.node}
          onNodeSelect={onNodeSelect}
        />
      );

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
}: {
  data: ObjectData;
  members?: Array<{ id: string; name: string; email: string; role: string }>;
  onNavigateToObject: (objectName: string) => void;
  onRefreshObject: () => void;
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
        // Refresh the object data to get updated relation labels
        onRefreshObject();
      }
    } catch {
      // ignore
    } finally {
      setUpdatingDisplayField(false);
    }
  };

  // Fields eligible to be the display field (text-like types)
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
          className="text-2xl font-bold capitalize"
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

          {/* Relation info badges */}
          {hasRelationFields && (
            <span
              className="text-xs px-2 py-1 rounded-full"
              style={{
                background: "rgba(96, 165, 250, 0.08)",
                color: "#60a5fa",
                border: "1px solid rgba(96, 165, 250, 0.2)",
              }}
            >
              {data.fields.filter((f) => f.type === "relation").length} relation{data.fields.filter((f) => f.type === "relation").length !== 1 ? "s" : ""}
            </span>
          )}
          {hasReverseRelations && (
            <span
              className="text-xs px-2 py-1 rounded-full"
              style={{
                background: "rgba(192, 132, 252, 0.08)",
                color: "#c084fc",
                border: "1px solid rgba(192, 132, 252, 0.2)",
              }}
            >
              {data.reverseRelations!.filter((rr) => Object.keys(rr.entries).length > 0).length} linked from
            </span>
          )}
        </div>

        {/* Display field selector */}
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
        className="text-2xl font-bold mb-1 capitalize"
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
              className="flex items-center gap-3 p-4 rounded-xl text-left transition-all duration-100 cursor-pointer"
              style={{
                background: "var(--color-surface)",
                border: "1px solid var(--color-border)",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor =
                  "var(--color-text-muted)";
                (e.currentTarget as HTMLElement).style.transform = "translateY(-1px)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor =
                  "var(--color-border)";
                (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
              }}
            >
              <span
                className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{
                  background:
                    child.type === "object"
                      ? "rgba(232, 93, 58, 0.1)"
                      : child.type === "document"
                        ? "rgba(96, 165, 250, 0.1)"
                        : child.type === "database"
                          ? "rgba(192, 132, 252, 0.1)"
                          : child.type === "report"
                            ? "rgba(34, 197, 94, 0.1)"
                            : "var(--color-surface-hover)",
                  color:
                    child.type === "object"
                      ? "var(--color-accent)"
                      : child.type === "document"
                        ? "#60a5fa"
                        : child.type === "database"
                          ? "#c084fc"
                          : child.type === "report"
                            ? "#22c55e"
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
                <div className="text-xs capitalize" style={{ color: "var(--color-text-muted)" }}>
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
  // Collect all objects and documents for quick access
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
        className="text-2xl font-bold mb-2"
        style={{ color: "var(--color-text)" }}
      >
        Workspace
      </h1>
      <p className="text-sm mb-8" style={{ color: "var(--color-text-muted)" }}>
        Select an item from the sidebar, or browse the sections below.
      </p>

      {/* Objects section */}
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
                className="flex items-center gap-3 p-4 rounded-xl text-left transition-all duration-100 cursor-pointer"
                style={{
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
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
                  className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{
                    background: "rgba(232, 93, 58, 0.1)",
                    color: "var(--color-accent)",
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

      {/* Documents section */}
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
                className="flex items-center gap-3 p-4 rounded-xl text-left transition-all duration-100 cursor-pointer"
                style={{
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor = "#60a5fa";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor =
                    "var(--color-border)";
                }}
              >
                <span
                  className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{
                    background: "rgba(96, 165, 250, 0.1)",
                    color: "#60a5fa",
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
