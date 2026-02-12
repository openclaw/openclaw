"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { WorkspaceSidebar } from "../components/workspace/workspace-sidebar";
import { type TreeNode } from "../components/workspace/knowledge-tree";
import { ObjectTable } from "../components/workspace/object-table";
import { ObjectKanban } from "../components/workspace/object-kanban";
import { DocumentView } from "../components/workspace/document-view";
import { FileViewer } from "../components/workspace/file-viewer";
import { DatabaseViewer } from "../components/workspace/database-viewer";
import { Breadcrumbs } from "../components/workspace/breadcrumbs";
import { EmptyState } from "../components/workspace/empty-state";

// --- Types ---

type WorkspaceContext = {
  exists: boolean;
  organization?: { id?: string; name?: string; slug?: string };
  members?: Array<{ id: string; name: string; email: string; role: string }>;
};

type ObjectData = {
  object: {
    id: string;
    name: string;
    description?: string;
    icon?: string;
    default_view?: string;
  };
  fields: Array<{
    id: string;
    name: string;
    type: string;
    enum_values?: string[];
    enum_colors?: string[];
    enum_multiple?: boolean;
    sort_order?: number;
  }>;
  statuses: Array<{
    id: string;
    name: string;
    color?: string;
    sort_order?: number;
  }>;
  entries: Record<string, unknown>[];
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

  const [tree, setTree] = useState<TreeNode[]>([]);
  const [context, setContext] = useState<WorkspaceContext | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState<ContentState>({ kind: "none" });
  const [treeLoading, setTreeLoading] = useState(true);
  const [workspaceExists, setWorkspaceExists] = useState(true);

  // Fetch tree and context on mount
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setTreeLoading(true);
      try {
        const [treeRes, ctxRes] = await Promise.all([
          fetch("/api/workspace/tree"),
          fetch("/api/workspace/context"),
        ]);

        const treeData = await treeRes.json();
        const ctxData = await ctxRes.json();

        if (cancelled) {return;}

        setTree(treeData.tree ?? []);
        setWorkspaceExists(treeData.exists ?? false);
        setContext(ctxData);
      } catch {
        if (!cancelled) {
          setTree([]);
          setWorkspaceExists(false);
        }
      } finally {
        if (!cancelled) {setTreeLoading(false);}
      }
    }

    load();
    return () => {
      cancelled = true;
    };
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
          // Database files are handled entirely by the DatabaseViewer component
          setContent({ kind: "database", dbPath: node.path, filename: node.name });
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

  return (
    <div className="flex h-screen" style={{ background: "var(--color-bg)" }}>
      {/* Sidebar */}
      <WorkspaceSidebar
        tree={tree}
        activePath={activePath}
        onSelect={handleNodeSelect}
        orgName={context?.organization?.name}
        loading={treeLoading}
      />

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar with breadcrumbs */}
        {activePath && (
          <div
            className="px-6 border-b flex-shrink-0"
            style={{ borderColor: "var(--color-border)" }}
          >
            <Breadcrumbs
              path={activePath}
              onNavigate={handleBreadcrumbNavigate}
            />
          </div>
        )}

        {/* Content area */}
        <div className="flex-1 overflow-y-auto">
          <ContentRenderer
            content={content}
            workspaceExists={workspaceExists}
            tree={tree}
            members={context?.members}
            onNodeSelect={handleNodeSelect}
          />
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
  members,
  onNodeSelect,
}: {
  content: ContentState;
  workspaceExists: boolean;
  tree: TreeNode[];
  members?: Array<{ id: string; name: string; email: string; role: string }>;
  onNodeSelect: (node: TreeNode) => void;
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
        <div className="p-6">
          {/* Object header */}
          <div className="mb-6">
            <h1
              className="text-2xl font-bold capitalize"
              style={{ color: "var(--color-text)" }}
            >
              {content.data.object.name}
            </h1>
            {content.data.object.description && (
              <p
                className="text-sm mt-1"
                style={{ color: "var(--color-text-muted)" }}
              >
                {content.data.object.description}
              </p>
            )}
            <div className="flex items-center gap-3 mt-3">
              <span
                className="text-xs px-2 py-1 rounded-full"
                style={{
                  background: "var(--color-surface)",
                  color: "var(--color-text-muted)",
                  border: "1px solid var(--color-border)",
                }}
              >
                {content.data.entries.length} entries
              </span>
              <span
                className="text-xs px-2 py-1 rounded-full"
                style={{
                  background: "var(--color-surface)",
                  color: "var(--color-text-muted)",
                  border: "1px solid var(--color-border)",
                }}
              >
                {content.data.fields.length} fields
              </span>
            </div>
          </div>

          {/* Table or Kanban */}
          {content.data.object.default_view === "kanban" ? (
            <ObjectKanban
              objectName={content.data.object.name}
              fields={content.data.fields}
              entries={content.data.entries}
              statuses={content.data.statuses}
              members={members}
            />
          ) : (
            <ObjectTable
              objectName={content.data.object.name}
              fields={content.data.fields}
              entries={content.data.entries}
              members={members}
            />
          )}
        </div>
      );

    case "document":
      return (
        <DocumentView
          content={content.data.content}
          title={content.title}
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
                          : "var(--color-surface-hover)",
                  color:
                    child.type === "object"
                      ? "var(--color-accent)"
                      : child.type === "document"
                        ? "#60a5fa"
                        : child.type === "database"
                          ? "#c084fc"
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
    default:
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" />
        </svg>
      );
  }
}
