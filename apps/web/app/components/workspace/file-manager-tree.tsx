"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { ContextMenu, type ContextMenuAction, type ContextMenuTarget } from "./context-menu";
import { InlineRename, RENAME_SHAKE_STYLE } from "./inline-rename";

// --- Types ---

export type TreeNode = {
  name: string;
  path: string;
  type: "object" | "document" | "folder" | "file" | "database" | "report";
  icon?: string;
  defaultView?: "table" | "kanban";
  children?: TreeNode[];
  /** When true, the node represents a virtual folder/file outside the real workspace (e.g. Skills, Memories). CRUD ops are disabled. */
  virtual?: boolean;
};

/** Folder names reserved for virtual sections -- cannot be created/renamed to. */
const RESERVED_FOLDER_NAMES = new Set(["Chats", "Skills", "Memories"]);

/** Check if a node (or any of its ancestors) is virtual. Paths starting with ~ are always virtual. */
function isVirtualNode(node: TreeNode): boolean {
  return !!node.virtual || node.path.startsWith("~");
}

type FileManagerTreeProps = {
  tree: TreeNode[];
  activePath: string | null;
  onSelect: (node: TreeNode) => void;
  onRefresh: () => void;
  compact?: boolean;
  /** Parent directory path for ".." navigation. Null when at filesystem root or in workspace mode without browsing. */
  parentDir?: string | null;
  /** Callback when user clicks ".." to navigate up. */
  onNavigateUp?: () => void;
  /** Current browse directory (absolute path), or null when in workspace mode. */
  browseDir?: string | null;
  /** Absolute path of the workspace root. Nodes matching this path are rendered as a special non-collapsible workspace entry point. */
  workspaceRoot?: string | null;
  /** Called when a node is dragged and dropped outside the tree onto an external drop target (e.g. chat input). */
  onExternalDrop?: (node: TreeNode) => void;
};

// --- System file detection (client-side mirror) ---

/** Always protected regardless of depth. */
const ALWAYS_SYSTEM_PATTERNS = [
  /^\.object\.yaml$/,
  /\.wal$/,
  /\.tmp$/,
];

/** Only protected at the workspace root (no "/" in the relative path). */
const ROOT_ONLY_SYSTEM_PATTERNS = [
  /^workspace\.duckdb/,
  /^workspace_context\.yaml$/,
];

function isSystemFile(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  if (ALWAYS_SYSTEM_PATTERNS.some((p) => p.test(base))) {return true;}
  const isRoot = !path.includes("/");
  return isRoot && ROOT_ONLY_SYSTEM_PATTERNS.some((p) => p.test(base));
}

// --- Icons (inline SVG, zero-dep) ---

function FolderIcon({ open }: { open?: boolean }) {
  return open ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

function TableIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18" /><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" />
    </svg>
  );
}

function KanbanIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="6" height="14" x="2" y="5" rx="1" /><rect width="6" height="10" x="9" y="5" rx="1" /><rect width="6" height="16" x="16" y="3" rx="1" />
    </svg>
  );
}

function DocumentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5V19A9 3 0 0 0 21 19V5" /><path d="M3 12A9 3 0 0 0 21 12" />
    </svg>
  );
}

function ReportIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" x2="12" y1="20" y2="10" /><line x1="18" x2="18" y1="20" y2="4" /><line x1="6" x2="6" y1="20" y2="14" />
    </svg>
  );
}

function ChatBubbleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function LockBadge() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 150ms ease" }}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function WorkspaceGridIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="7" height="7" x="3" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="14" rx="1" />
      <rect width="7" height="7" x="3" y="14" rx="1" />
    </svg>
  );
}

function NodeIcon({ node, open }: { node: TreeNode; open?: boolean }) {
  // Chat items use the chat bubble icon
  if (node.path.startsWith("~chats/") || node.path === "~chats") {
    return <ChatBubbleIcon />;
  }
  switch (node.type) {
    case "object":
      return node.defaultView === "kanban" ? <KanbanIcon /> : <TableIcon />;
    case "document":
      return <DocumentIcon />;
    case "folder":
      return <FolderIcon open={open} />;
    case "database":
      return <DatabaseIcon />;
    case "report":
      return <ReportIcon />;
    default:
      return <FileIcon />;
  }
}

function typeColor(node: TreeNode): string {
  switch (node.type) {
    case "object": return "var(--color-accent)";
    case "document": return "#60a5fa";
    case "database": return "#c084fc";
    case "report": return "#22c55e";
    default: return "var(--color-text-muted)";
  }
}

// --- API helpers ---

async function apiRename(path: string, newName: string) {
  const res = await fetch("/api/workspace/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, newName }),
  });
  return res.json();
}

async function apiDelete(path: string) {
  const res = await fetch("/api/workspace/file", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  return res.json();
}

async function apiMove(sourcePath: string, destinationDir: string) {
  const res = await fetch("/api/workspace/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourcePath, destinationDir }),
  });
  return res.json();
}

async function apiDuplicate(path: string) {
  const res = await fetch("/api/workspace/copy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  return res.json();
}

async function apiMkdir(path: string) {
  const res = await fetch("/api/workspace/mkdir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  return res.json();
}

async function apiCreateFile(path: string, content: string = "") {
  const res = await fetch("/api/workspace/file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
  return res.json();
}

// --- Confirm dialog ---

function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {onCancel();}
      if (e.key === "Enter") {onConfirm();}
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onConfirm, onCancel]);

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.5)" }}>
      <div className="rounded-xl p-5 max-w-sm w-full shadow-2xl border" style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}>
        <p className="text-sm mb-4" style={{ color: "var(--color-text)" }}>{message}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-sm"
            style={{ color: "var(--color-text-muted)", background: "var(--color-surface-hover)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3 py-1.5 rounded-md text-sm text-white"
            style={{ background: "#ef4444" }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// --- New item prompt ---

function NewItemPrompt({
  kind,
  parentPath,
  onSubmit,
  onCancel,
}: {
  kind: "file" | "folder";
  parentPath: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(kind === "file" ? "untitled.md" : "new-folder");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) {return;}
    el.focus();
    if (kind === "file") {
      const dot = value.lastIndexOf(".");
      el.setSelectionRange(0, dot > 0 ? dot : value.length);
    } else {
      el.select();
    }
  }, []);

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.5)" }}>
      <div className="rounded-xl p-5 max-w-sm w-full shadow-2xl border" style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}>
        <p className="text-sm mb-3 font-medium" style={{ color: "var(--color-text)" }}>
          New {kind} in <span style={{ color: "var(--color-accent)" }}>{parentPath || "/"}</span>
        </p>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {onSubmit(value.trim());}
            if (e.key === "Escape") {onCancel();}
          }}
          className="w-full px-3 py-2 rounded-md text-sm outline-none border"
          style={{ background: "var(--color-bg)", color: "var(--color-text)", borderColor: "var(--color-border)" }}
        />
        <div className="flex justify-end gap-2 mt-3">
          <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded-md text-sm" style={{ color: "var(--color-text-muted)", background: "var(--color-surface-hover)" }}>
            Cancel
          </button>
          <button type="button" onClick={() => onSubmit(value.trim())} className="px-3 py-1.5 rounded-md text-sm text-white" style={{ background: "var(--color-accent)" }}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Draggable + Droppable Node ---

function DraggableNode({
  node,
  depth,
  activePath,
  selectedPath,
  onSelect,
  onNodeSelect,
  expandedPaths,
  onToggleExpand,
  renamingPath,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onContextMenu,
  compact,
  dragOverPath,
  workspaceRoot,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  selectedPath: string | null;
  onSelect: (node: TreeNode) => void;
  onNodeSelect: (path: string) => void;
  expandedPaths: Set<string>;
  onToggleExpand: (path: string) => void;
  renamingPath: string | null;
  onStartRename: (path: string) => void;
  onCommitRename: (newName: string) => void;
  onCancelRename: () => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  compact?: boolean;
  dragOverPath: string | null;
  workspaceRoot?: string | null;
}) {
  // Workspace root in browse mode: non-expandable entry point back to workspace
  const isWorkspaceRoot = !!workspaceRoot && node.path === workspaceRoot;
  const hasChildren = node.children && node.children.length > 0;
  const isExpandable = isWorkspaceRoot ? false : (hasChildren || node.type === "folder" || node.type === "object");
  const isExpanded = isWorkspaceRoot ? false : expandedPaths.has(node.path);
  const isActive = activePath === node.path;
  const isSelected = selectedPath === node.path;
  const isRenaming = renamingPath === node.path;
  const isSysFile = isSystemFile(node.path);
  const isVirtual = isVirtualNode(node);
  const isProtected = isSysFile || isVirtual || isWorkspaceRoot;
  const isDragOver = dragOverPath === node.path && isExpandable;

  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: `drag-${node.path}`,
    data: { node },
    disabled: isProtected,
  });

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop-${node.path}`,
    data: { node },
    disabled: !isExpandable || isVirtual,
  });

  const handleClick = useCallback(() => {
    onNodeSelect(node.path);
    onSelect(node);
    if (isExpandable) {
      onToggleExpand(node.path);
    }
  }, [node, isExpandable, onSelect, onNodeSelect, onToggleExpand]);

  const handleDoubleClick = useCallback(() => {
    if (!isProtected) {
      onStartRename(node.path);
    }
  }, [node.path, isProtected, onStartRename]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onNodeSelect(node.path);
      onContextMenu(e, node);
    },
    [node, onNodeSelect, onContextMenu],
  );

  // Merge drag + drop refs
  const mergedRef = useCallback(
    (el: HTMLElement | null) => {
      setDragRef(el);
      setDropRef(el);
    },
    [setDragRef, setDropRef],
  );

  const showDropHighlight = (isOver || isDragOver) && isExpandable;

  return (
    <div style={{ opacity: isDragging ? 0.4 : 1 }}>
      <div
        ref={mergedRef}
        {...attributes}
        {...listeners}
        role="treeitem"
        tabIndex={-1}
        draggable={!isProtected}
        onDragStart={(e) => {
          // Native HTML5 drag for cross-component drops (e.g. into chat editor).
          // Coexists with @dnd-kit which uses pointer events for intra-tree reordering.
          e.dataTransfer.setData(
            "application/x-file-mention",
            JSON.stringify({ name: node.name, path: node.path }),
          );
          e.dataTransfer.setData("text/plain", node.path);
          e.dataTransfer.effectAllowed = "copy";
        }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        className="w-full flex items-center gap-1.5 py-1 px-2 rounded-md text-left text-sm transition-colors duration-100 cursor-pointer select-none"
        style={{
          paddingLeft: `${depth * 16 + 8}px`,
          background: isWorkspaceRoot
            ? "var(--color-accent-light)"
            : showDropHighlight
              ? "var(--color-accent-light)"
              : isSelected
                ? "var(--color-surface-hover)"
                : isActive
                  ? "var(--color-surface-hover)"
                  : "transparent",
          color: isWorkspaceRoot
            ? "var(--color-accent)"
            : isActive || isSelected ? "var(--color-text)" : "var(--color-text-muted)",
          outline: isWorkspaceRoot
            ? "1.5px solid var(--color-accent)"
            : showDropHighlight ? "1px dashed var(--color-accent)" : "none",
          outlineOffset: "-1px",
          borderRadius: isWorkspaceRoot ? "8px" : "6px",
          marginTop: isWorkspaceRoot ? "2px" : undefined,
          marginBottom: isWorkspaceRoot ? "2px" : undefined,
        }}
        onMouseEnter={(e) => {
          if (isWorkspaceRoot) {
            (e.currentTarget as HTMLElement).style.opacity = "0.8";
          } else if (!isActive && !isSelected && !showDropHighlight) {
            (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
          }
        }}
        onMouseLeave={(e) => {
          if (isWorkspaceRoot) {
            (e.currentTarget as HTMLElement).style.opacity = "1";
          } else if (!isActive && !isSelected && !showDropHighlight) {
            (e.currentTarget as HTMLElement).style.background = "transparent";
          }
        }}
      >
        {/* Expand/collapse chevron – intercept click so it only toggles without navigating */}
        <span
          className="flex-shrink-0 w-4 h-4 flex items-center justify-center"
          style={{ opacity: isExpandable ? 1 : 0, cursor: isExpandable ? "pointer" : undefined }}
          onClick={isExpandable ? (e) => { e.stopPropagation(); onToggleExpand(node.path); } : undefined}
        >
          {isExpandable && <ChevronIcon open={isExpanded} />}
        </span>

        {/* Icon */}
        <span className="flex-shrink-0 flex items-center" style={{ color: isWorkspaceRoot ? "var(--color-accent)" : typeColor(node) }}>
          {isWorkspaceRoot ? <WorkspaceGridIcon /> : <NodeIcon node={node} open={isExpanded} />}
        </span>

        {/* Label or rename input */}
        {isRenaming ? (
          <InlineRename
            currentName={node.name}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <span className="truncate flex-1">{node.name.replace(/\.md$/, "")}</span>
        )}

        {/* Workspace badge for the workspace root entry point */}
        {isWorkspaceRoot && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 font-medium"
            style={{ background: "var(--color-accent)", color: "white" }}>
            workspace
          </span>
        )}

        {/* Lock badge for system/virtual files (skip for workspace root -- it has its own badge) */}
        {isProtected && !isWorkspaceRoot && !compact && (
          <span className="flex-shrink-0 ml-1">
            <LockBadge />
          </span>
        )}

        {/* Type badge for objects */}
        {node.type === "object" && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0"
            style={{ background: "var(--color-accent-light)", color: "var(--color-accent)" }}>
            {node.defaultView === "kanban" ? "board" : "table"}
          </span>
        )}
      </div>

      {/* Children */}
      {isExpanded && hasChildren && (
        <div className="relative" style={{
          borderLeft: depth > 0 ? "1px solid var(--color-border)" : "none",
          marginLeft: `${depth * 16 + 16}px`,
        }}>
          {node.children!.map((child) => (
            <DraggableNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onNodeSelect={onNodeSelect}
              expandedPaths={expandedPaths}
              onToggleExpand={onToggleExpand}
              renamingPath={renamingPath}
              onStartRename={onStartRename}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              onContextMenu={onContextMenu}
              compact={compact}
              dragOverPath={dragOverPath}
              workspaceRoot={workspaceRoot}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Root drop zone (allows dropping items back to the top level) ---

function RootDropZone({ isDragging }: { isDragging: boolean }) {
  const { setNodeRef, isOver } = useDroppable({
    id: "drop-__root__",
    data: { rootDrop: true },
  });

  const showHighlight = isOver && isDragging;

  return (
    <div
      ref={setNodeRef}
      className="flex-1 min-h-[48px]"
      style={{
        margin: isDragging ? "4px 8px" : undefined,
        borderRadius: "6px",
        border: showHighlight ? "1.5px dashed var(--color-accent)" : isDragging ? "1.5px dashed var(--color-border)" : "1.5px dashed transparent",
        background: showHighlight ? "var(--color-accent-light)" : "transparent",
        transition: "all 150ms ease",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {isDragging && (
        <span className="text-[11px] select-none" style={{ color: showHighlight ? "var(--color-accent)" : "var(--color-text-muted)", opacity: showHighlight ? 1 : 0.6 }}>
          Drop here to move to root
        </span>
      )}
    </div>
  );
}

// --- Drag Overlay ---

function DragOverlayContent({ node }: { node: TreeNode }) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm shadow-lg border"
      style={{
        background: "var(--color-surface)",
        borderColor: "var(--color-border)",
        color: "var(--color-text)",
        pointerEvents: "none",
      }}
    >
      <span style={{ color: typeColor(node) }}>
        <NodeIcon node={node} />
      </span>
      <span>{node.name}</span>
    </div>
  );
}

// --- Helper: find node by path ---

function findNode(tree: TreeNode[], path: string): TreeNode | null {
  for (const n of tree) {
    if (n.path === path) {return n;}
    if (n.children) {
      const found = findNode(n.children, path);
      if (found) {return found;}
    }
  }
  return null;
}

// --- Helper: get parent path ---

function parentPath(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/") || ".";
}

// --- Flatten tree for keyboard navigation ---

function flattenVisible(tree: TreeNode[], expanded: Set<string>): TreeNode[] {
  const result: TreeNode[] = [];
  function walk(nodes: TreeNode[]) {
    for (const n of nodes) {
      result.push(n);
      if (n.children && expanded.has(n.path)) {
        walk(n.children);
      }
    }
  }
  walk(tree);
  return result;
}

// --- Main Exported Component ---

export function FileManagerTree({ tree, activePath, onSelect, onRefresh, compact, parentDir, onNavigateUp, browseDir: _browseDir, workspaceRoot, onExternalDrop }: FileManagerTreeProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [activeNode, setActiveNode] = useState<TreeNode | null>(null);

  // Track pointer position during @dnd-kit drags for cross-component drops.
  // Capture-phase listener on window works even when @dnd-kit has pointer capture.
  const pointerPosRef = useRef({ x: 0, y: 0 });
  useEffect(() => {
    if (!activeNode) {return;}

    const onPointerMove = (e: PointerEvent) => {
      pointerPosRef.current = { x: e.clientX, y: e.clientY };

      // Toggle visual drop indicator on external chat drop target
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const target = el?.closest("[data-chat-drop-target]") as HTMLElement | null;
      const prev = document.querySelector("[data-drag-hover]");
      if (target && !target.hasAttribute("data-drag-hover")) {
        target.setAttribute("data-drag-hover", "");
      }
      if (prev && prev !== target) {
        prev.removeAttribute("data-drag-hover");
      }
    };

    window.addEventListener("pointermove", onPointerMove, true);
    return () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      // Clean up any lingering highlight
      document.querySelector("[data-drag-hover]")?.removeAttribute("data-drag-hover");
    };
  }, [activeNode]);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; target: ContextMenuTarget } | null>(null);

  // Confirm dialog
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // New item prompt
  const [newItemPrompt, setNewItemPrompt] = useState<{ kind: "file" | "folder"; parentPath: string } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-expand first level on mount.
  // Keep ~skills and ~memories collapsed by default; always expand ~chats.
  const collapsedByDefault = new Set(["~skills", "~memories"]);
  useEffect(() => {
    if (tree.length > 0 && expandedPaths.size === 0) {
      const initial = new Set<string>();
      for (const node of tree) {
        if (collapsedByDefault.has(node.path)) {continue;}
        if (node.children && node.children.length > 0) {
          initial.add(node.path);
        }
      }
      setExpandedPaths(initial);
    }
  }, [tree]);

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {next.delete(path);}
      else {next.add(path);}
      return next;
    });
  }, []);

  // DnD sensors -- require 8px movement before dragging starts (prevents accidental drags on click)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as { node: TreeNode } | undefined;
    if (data?.node) {setActiveNode(data.node);}
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const overData = event.over?.data.current as { node?: TreeNode; rootDrop?: boolean } | undefined;
    if (overData?.rootDrop) {
      setDragOverPath("__root__");
    } else if (overData?.node) {
      setDragOverPath(overData.node.path);
      // Auto-expand folders on drag hover (300ms delay)
      const path = overData.node.path;
      if (overData.node.type === "folder" || overData.node.type === "object") {
        setTimeout(() => {
          setExpandedPaths((prev) => {
            if (prev.has(path)) {return prev;}
            const next = new Set(prev);
            next.add(path);
            return next;
          });
        }, 300);
      }
    } else {
      setDragOverPath(null);
    }
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveNode(null);
      setDragOverPath(null);

      const activeData = event.active.data.current as { node: TreeNode } | undefined;
      const overData = event.over?.data.current as { node?: TreeNode; rootDrop?: boolean } | undefined;

      if (!activeData?.node) {return;}

      const source = activeData.node;

      // Drop onto root level
      if (overData?.rootDrop) {
        // Already at root? No-op
        if (parentPath(source.path) === ".") {return;}
        const result = await apiMove(source.path, ".");
        if (result.ok) {
          onRefresh();
        }
        return;
      }

      // No @dnd-kit droppable: check for external drop targets (e.g. chat input)
      if (!overData?.node) {
        if (onExternalDrop) {
          const { x, y } = pointerPosRef.current;
          const el = document.elementFromPoint(x, y);
          if (el?.closest("[data-chat-drop-target]")) {
            onExternalDrop(source);
          }
        }
        return;
      }

      const target = overData.node;

      // Only drop onto expandable targets (folders/objects)
      if (target.type !== "folder" && target.type !== "object") {return;}

      // Prevent dropping into self or children
      if (target.path === source.path || target.path.startsWith(source.path + "/")) {return;}

      // Prevent no-op moves (already in same parent)
      if (parentPath(source.path) === target.path) {return;}

      const result = await apiMove(source.path, target.path);
      if (result.ok) {
        onRefresh();
      }
    },
    [onRefresh, onExternalDrop],
  );

  const handleDragCancel = useCallback(() => {
    setActiveNode(null);
    setDragOverPath(null);
    document.querySelector("[data-drag-hover]")?.removeAttribute("data-drag-hover");
  }, []);

  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent, node: TreeNode) => {
    const isSys = isSystemFile(node.path) || isVirtualNode(node);
    const isFolder = node.type === "folder" || node.type === "object";
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      target: {
        kind: isFolder ? "folder" : "file",
        path: node.path,
        name: node.name,
        isSystem: isSys,
      },
    });
  }, []);

  const handleEmptyContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      target: { kind: "empty" },
    });
  }, []);

  const handleContextMenuAction = useCallback(
    async (action: ContextMenuAction) => {
      const target = ctxMenu?.target;
      if (!target) {return;}

      switch (action) {
        case "open": {
          if (target.kind !== "empty") {
            const node = findNode(tree, target.path);
            if (node) {onSelect(node);}
          }
          break;
        }
        case "rename": {
          if (target.kind !== "empty") {
            setRenamingPath(target.path);
          }
          break;
        }
        case "duplicate": {
          if (target.kind !== "empty") {
            await apiDuplicate(target.path);
            onRefresh();
          }
          break;
        }
        case "copy": {
          if (target.kind !== "empty") {
            await navigator.clipboard.writeText(target.path);
          }
          break;
        }
        case "delete": {
          if (target.kind !== "empty") {
            setConfirmDelete(target.path);
          }
          break;
        }
        case "newFile": {
          const parent = target.kind === "folder" ? target.path : target.kind === "file" ? parentPath(target.path) : "";
          setNewItemPrompt({ kind: "file", parentPath: parent });
          break;
        }
        case "newFolder": {
          const parent = target.kind === "folder" ? target.path : target.kind === "file" ? parentPath(target.path) : "";
          setNewItemPrompt({ kind: "folder", parentPath: parent });
          break;
        }
        case "getInfo": {
          // Future: show info panel. For now, copy path.
          if (target.kind !== "empty") {
            await navigator.clipboard.writeText(target.path);
          }
          break;
        }
      }
    },
    [ctxMenu, tree, onSelect, onRefresh],
  );

  // Rename handlers
  const handleCommitRename = useCallback(
    async (newName: string) => {
      if (!renamingPath) {return;}
      // Block reserved folder names
      if (RESERVED_FOLDER_NAMES.has(newName)) {
        alert(`"${newName}" is a reserved name and cannot be used.`);
        setRenamingPath(null);
        return;
      }
      const result = await apiRename(renamingPath, newName);
      setRenamingPath(null);
      if (result.ok) {onRefresh();}
    },
    [renamingPath, onRefresh],
  );

  const handleCancelRename = useCallback(() => {
    setRenamingPath(null);
  }, []);

  // Delete confirm
  const handleConfirmDelete = useCallback(async () => {
    if (!confirmDelete) {return;}
    const result = await apiDelete(confirmDelete);
    setConfirmDelete(null);
    if (result.ok) {onRefresh();}
  }, [confirmDelete, onRefresh]);

  // New item submit
  const handleNewItemSubmit = useCallback(
    async (name: string) => {
      if (!newItemPrompt || !name) {return;}

      // Block reserved folder names
      if (RESERVED_FOLDER_NAMES.has(name)) {
        alert(`"${name}" is a reserved name and cannot be used.`);
        return;
      }

      const fullPath = newItemPrompt.parentPath ? `${newItemPrompt.parentPath}/${name}` : name;

      if (newItemPrompt.kind === "folder") {
        await apiMkdir(fullPath);
      } else {
        await apiCreateFile(fullPath, "");
      }

      setNewItemPrompt(null);
      onRefresh();

      // Auto-expand parent
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        next.add(newItemPrompt.parentPath);
        return next;
      });
    },
    [newItemPrompt, onRefresh],
  );

  // Keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Don't capture keyboard events when renaming
      if (renamingPath) {return;}

      const flat = flattenVisible(tree, expandedPaths);
      const curIdx = flat.findIndex((n) => n.path === selectedPath);
      const curNode = curIdx >= 0 ? flat[curIdx] : null;

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const next = curIdx < flat.length - 1 ? flat[curIdx + 1] : flat[0];
          if (next) {setSelectedPath(next.path);}
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const prev = curIdx > 0 ? flat[curIdx - 1] : flat[flat.length - 1];
          if (prev) {setSelectedPath(prev.path);}
          break;
        }
        case "ArrowRight": {
          e.preventDefault();
          if (curNode && (curNode.type === "folder" || curNode.type === "object")) {
            setExpandedPaths((p) => new Set([...p, curNode.path]));
          }
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          if (curNode && expandedPaths.has(curNode.path)) {
            setExpandedPaths((p) => {
              const n = new Set(p);
              n.delete(curNode.path);
              return n;
            });
          }
          break;
        }
        case "Enter": {
          e.preventDefault();
          if (curNode) {
            const curProtected = isSystemFile(curNode.path) || isVirtualNode(curNode);
            if (e.shiftKey || curProtected) {
              onSelect(curNode);
            } else {
              setRenamingPath(curNode.path);
            }
          }
          break;
        }
        case "F2": {
          e.preventDefault();
          if (curNode && !isSystemFile(curNode.path) && !isVirtualNode(curNode)) {
            setRenamingPath(curNode.path);
          }
          break;
        }
        case "Backspace":
        case "Delete": {
          if (curNode && !isSystemFile(curNode.path) && !isVirtualNode(curNode)) {
            e.preventDefault();
            setConfirmDelete(curNode.path);
          }
          break;
        }
        default: {
          // Cmd+key shortcuts
          if (e.metaKey || e.ctrlKey) {
            if (e.key === "c" && curNode) {
              e.preventDefault();
              void navigator.clipboard.writeText(curNode.path);
            } else if (e.key === "d" && curNode && !isSystemFile(curNode.path)) {
              e.preventDefault();
              void apiDuplicate(curNode.path).then(() => onRefresh());
            } else if (e.key === "n") {
              e.preventDefault();
              const parent = curNode
                ? curNode.type === "folder" || curNode.type === "object"
                  ? curNode.path
                  : parentPath(curNode.path)
                : "";
              if (e.shiftKey) {
                setNewItemPrompt({ kind: "folder", parentPath: parent });
              } else {
                setNewItemPrompt({ kind: "file", parentPath: parent });
              }
            }
          }
          break;
        }
      }
    },
    [tree, expandedPaths, selectedPath, renamingPath, onSelect, onRefresh],
  );

  if (tree.length === 0) {
    return (
      <div
        className="px-4 py-6 text-center text-sm"
        style={{ color: "var(--color-text-muted)" }}
        onContextMenu={handleEmptyContextMenu}
      >
        No files in workspace
        {ctxMenu && (
          <ContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            target={ctxMenu.target}
            onAction={handleContextMenuAction}
            onClose={() => setCtxMenu(null)}
          />
        )}
        {newItemPrompt && (
          <NewItemPrompt
            kind={newItemPrompt.kind}
            parentPath={newItemPrompt.parentPath}
            onSubmit={handleNewItemSubmit}
            onCancel={() => setNewItemPrompt(null)}
          />
        )}
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div
        ref={containerRef}
        className="py-1 outline-none flex flex-col min-h-full"
        tabIndex={0}
        role="tree"
        onKeyDown={handleKeyDown}
        onContextMenu={handleEmptyContextMenu}
      >
        {/* ".." navigation entry for browsing up */}
        {parentDir != null && onNavigateUp && (
          <div
            role="treeitem"
            tabIndex={-1}
            onClick={onNavigateUp}
            className="w-full flex items-center gap-1.5 py-1 px-2 rounded-md text-left text-sm transition-colors duration-100 cursor-pointer select-none"
            style={{
              paddingLeft: "8px",
              color: "var(--color-text-muted)",
              borderRadius: "6px",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "transparent";
            }}
          >
            <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </span>
            <span className="flex-shrink-0 flex items-center" style={{ color: "var(--color-text-muted)" }}>
              <FolderIcon />
            </span>
            <span className="truncate flex-1">..</span>
          </div>
        )}
        {tree.map((node) => (
          <DraggableNode
            key={node.path}
            node={node}
            depth={0}
            activePath={activePath}
            selectedPath={selectedPath}
            onSelect={onSelect}
            onNodeSelect={setSelectedPath}
            expandedPaths={expandedPaths}
            onToggleExpand={handleToggleExpand}
            renamingPath={renamingPath}
            onStartRename={setRenamingPath}
            onCommitRename={handleCommitRename}
            onCancelRename={handleCancelRename}
            onContextMenu={handleContextMenu}
            compact={compact}
            dragOverPath={dragOverPath}
            workspaceRoot={workspaceRoot}
          />
        ))}
        {/* Root-level drop zone: fills remaining space so items can be moved to root */}
        <RootDropZone isDragging={!!activeNode} />
      </div>

      {/* Drag overlay (ghost) */}
      <DragOverlay dropAnimation={null}>
        {activeNode ? <DragOverlayContent node={activeNode} /> : null}
      </DragOverlay>

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          target={ctxMenu.target}
          onAction={handleContextMenuAction}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* Delete confirmation dialog */}
      {confirmDelete && (
        <ConfirmDialog
          message={`Are you sure you want to delete "${confirmDelete.split("/").pop()}"? This action cannot be undone.`}
          onConfirm={handleConfirmDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {/* New file/folder prompt */}
      {newItemPrompt && (
        <NewItemPrompt
          kind={newItemPrompt.kind}
          parentPath={newItemPrompt.parentPath}
          onSubmit={handleNewItemSubmit}
          onCancel={() => setNewItemPrompt(null)}
        />
      )}

      {/* Inject animation styles */}
      <style>{RENAME_SHAKE_STYLE}</style>
    </DndContext>
  );
}
