"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  IconFolderFilled,
  IconFolderOpenFilled,
  IconFileFilled,
  IconTableFilled,
  IconLayoutKanbanFilled,
  IconDatabaseFilled,
  IconReportAnalyticsFilled,
  IconMessageFilled,
  IconAppsFilled,
} from "@tabler/icons-react";
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
import { type ContextMenuAction, type ContextMenuTarget, getMenuItems, LockIcon } from "./context-menu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "../ui/context-menu";
import { InlineRename, RENAME_SHAKE_STYLE } from "./inline-rename";
import {
  classifyWorkspacePath,
  fileWriteUrl,
  isVirtualPath,
  toLocalClipboardPath,
} from "@/lib/workspace-paths";

// --- Types ---

export type TreeNode = {
  name: string;
  path: string;
  type: "object" | "document" | "folder" | "file" | "database" | "report" | "app";
  icon?: string;
  defaultView?: "table" | "kanban";
  children?: TreeNode[];
  /** When true, the node represents a virtual folder/file outside the real workspace (e.g. Skills, Memories). CRUD ops are disabled. */
  virtual?: boolean;
  /** True when the entry is a symbolic link / shortcut. */
  symlink?: boolean;
  /** App manifest metadata (only for type: "app"). */
  appManifest?: {
    name: string;
    description?: string;
    icon?: string;
    version?: string;
    entry?: string;
    runtime?: string;
  };
};

/** Check if a node (or any of its ancestors) is virtual. */
function isVirtualNode(node: TreeNode): boolean {
  return !!node.virtual || isVirtualPath(node.path);
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

function toWorkspaceRelativePath(path: string, workspaceRoot?: string | null): string | null {
  const kind = classifyWorkspacePath(path);
  if (kind === "virtual" || kind === "homeRelative") {return null;}
  if (kind === "workspaceRelative") {return path;}
  if (!workspaceRoot) {return null;}
  if (path !== workspaceRoot && !path.startsWith(`${workspaceRoot}/`)) {
    return null;
  }
  return path === workspaceRoot ? "" : path.slice(workspaceRoot.length + 1);
}

function isSystemFile(path: string, workspaceRoot?: string | null): boolean {
  const relativePath = toWorkspaceRelativePath(path, workspaceRoot);
  if (relativePath == null) {return false;}
  const base = relativePath.split("/").pop() ?? "";
  if (ALWAYS_SYSTEM_PATTERNS.some((p) => p.test(base))) {return true;}
  const isRoot = relativePath !== "" && !relativePath.includes("/");
  return isRoot && ROOT_ONLY_SYSTEM_PATTERNS.some((p) => p.test(base));
}

// --- Icons (inline SVG, zero-dep) ---

function FolderIcon({ open }: { open?: boolean }) {
  return open
    ? <IconFolderOpenFilled size={18} style={{ flexShrink: 0, color: "#60a5fa" }} />
    : <IconFolderFilled size={18} style={{ flexShrink: 0, color: "#60a5fa" }} />;
}

function TableIcon() {
  return <IconTableFilled size={18} style={{ flexShrink: 0, color: "#42a97a" }} />;
}

function KanbanIcon() {
  return <IconLayoutKanbanFilled size={18} style={{ flexShrink: 0, color: "#8b7cf6" }} />;
}

function DocumentIcon() {
  return <IconFileFilled size={18} style={{ flexShrink: 0, opacity: 0.7 }} />;
}

function FileIcon() {
  return <IconFileFilled size={18} style={{ flexShrink: 0, opacity: 0.7 }} />;
}

function DatabaseIcon() {
  return <IconDatabaseFilled size={18} style={{ flexShrink: 0 }} />;
}

function ReportIcon() {
  return <IconReportAnalyticsFilled size={18} style={{ flexShrink: 0 }} />;
}

function ChatBubbleIcon() {
  return <IconMessageFilled size={18} style={{ flexShrink: 0 }} />;
}

function AppNodeIcon() {
  return <IconAppsFilled size={18} style={{ flexShrink: 0 }} />;
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
    case "app": {
      const icon = node.appManifest?.icon ?? node.icon;
      if (icon && (icon.endsWith(".png") || icon.endsWith(".svg") || icon.endsWith(".jpg") || icon.endsWith(".jpeg") || icon.endsWith(".webp"))) {
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/apps/serve/${node.path}/${icon}`}
            alt=""
            width={16}
            height={16}
            className="rounded-sm flex-shrink-0"
            style={{ objectFit: "cover" }}
          />
        );
      }
      return <AppNodeIcon />;
    }
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
    case "app": return "#6366f1";
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
  const res = await fetch(fileWriteUrl(path), {
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
  const isExpandable = isWorkspaceRoot ? false : !!hasChildren;
  const isExpanded = isWorkspaceRoot ? false : expandedPaths.has(node.path);
  const isActive = activePath === node.path;
  const isSelected = selectedPath === node.path;
  const shouldToggleOnClick = isExpandable;
  const isRenaming = renamingPath === node.path;
  const isSysFile = isSystemFile(node.path, workspaceRoot);
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
    if (shouldToggleOnClick) {
      onToggleExpand(node.path);
    }
  }, [node, onSelect, onNodeSelect, onToggleExpand, shouldToggleOnClick]);

  const handleDoubleClick = useCallback(() => {
    // no-op: rename is only available via context menu
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
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
        className="w-full flex items-center gap-2 py-1.5 px-2 rounded-xl text-left text-sm transition-all duration-100 cursor-pointer select-none"
        style={{
          paddingLeft: `${depth * 20 + 14}px`,
          background: showDropHighlight
            ? "var(--color-accent-light)"
            : isSelected || isActive
              ? "var(--color-surface-hover)"
              : "transparent",
          color: isActive || isSelected ? "var(--color-text)" : "var(--color-text-secondary)",
          outline: showDropHighlight ? "1px dashed var(--color-accent)" : "none",
          outlineOffset: "-1px",
        }}
        onMouseEnter={(e) => {
          if (!isActive && !isSelected && !showDropHighlight) {
            (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
          }
        }}
        onMouseLeave={(e) => {
          if (!isActive && !isSelected && !showDropHighlight) {
            (e.currentTarget as HTMLElement).style.background = "transparent";
          }
        }}
      >
        <span className="flex-shrink-0 flex items-center" style={{ color: "var(--color-text-muted)", opacity: 0.55, filter: "drop-shadow(0 0.5px 1px rgba(0,0,0,0.15))" }}>
          <NodeIcon node={node} open={isExpanded} />
        </span>

        {isRenaming ? (
          <InlineRename
            currentName={node.name}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <span className="truncate flex-1">{node.name}</span>
        )}

      </div>

      {isExpanded && hasChildren && (
        <div>
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

const STORAGE_KEY = "denchclaw-tree-expanded";

function loadExpandedPaths(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as string[];
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch { /* ignore corrupt data */ }
  return new Set();
}

function saveExpandedPaths(paths: Set<string>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...paths]));
  } catch { /* storage full or unavailable */ }
}

export function FileManagerTree({ tree, activePath, onSelect, onRefresh, compact, parentDir, onNavigateUp, browseDir: _browseDir, workspaceRoot, onExternalDrop }: FileManagerTreeProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => loadExpandedPaths());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  useEffect(() => {
    if (activePath === null) {
      setSelectedPath(null);
      return;
    }
    setSelectedPath(null);
    const relativePath = workspaceRoot && activePath.startsWith(workspaceRoot + "/")
      ? activePath.slice(workspaceRoot.length + 1)
      : activePath;
    const parts = relativePath.split("/");
    if (parts.length > 1) {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (let i = 1; i < parts.length; i++) {
          const ancestor = parts.slice(0, i).join("/");
          if (!next.has(ancestor)) {
            next.add(ancestor);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
  }, [activePath, workspaceRoot]);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [activeNode, setActiveNode] = useState<TreeNode | null>(null);

  // Track pointer position during @dnd-kit drags for cross-component drops.
  // Installed synchronously in handleDragStart (not useEffect) to avoid
  // missing early pointer moves. Capture-phase on window fires before
  // @dnd-kit's own document-level listener.
  const pointerPosRef = useRef({ x: 0, y: 0 });
  const pointerListenerRef = useRef<((e: PointerEvent) => void) | null>(null);

  const installPointerTracker = useCallback(() => {
    const handler = (e: PointerEvent) => {
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
    pointerListenerRef.current = handler;
    window.addEventListener("pointermove", handler, true);
  }, []);

  const removePointerTracker = useCallback(() => {
    if (pointerListenerRef.current) {
      window.removeEventListener("pointermove", pointerListenerRef.current, true);
      pointerListenerRef.current = null;
    }
    document.querySelector("[data-drag-hover]")?.removeAttribute("data-drag-hover");
  }, []);

  // Clean up on unmount
  useEffect(() => removePointerTracker, [removePointerTracker]);

  // Context menu state
  const [ctxTarget, setCtxTarget] = useState<ContextMenuTarget>({ kind: "empty" });
  const ctxEventIdRef = useRef<number>(0);

  // Confirm dialog
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // New item prompt
  const [newItemPrompt, setNewItemPrompt] = useState<{ kind: "file" | "folder"; parentPath: string } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const dragExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentDragOverRef = useRef<string | null>(null);

  // Persist expanded paths to localStorage whenever they change
  useEffect(() => {
    saveExpandedPaths(expandedPaths);
  }, [expandedPaths]);

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
    if (data?.node) {
      setActiveNode(data.node);
      installPointerTracker();
    }
  }, [installPointerTracker]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const overData = event.over?.data.current as { node?: TreeNode; rootDrop?: boolean } | undefined;
    if (overData?.rootDrop) {
      if (currentDragOverRef.current !== "__root__") {
        if (dragExpandTimerRef.current) clearTimeout(dragExpandTimerRef.current);
        currentDragOverRef.current = "__root__";
      }
      setDragOverPath("__root__");
    } else if (overData?.node) {
      const path = overData.node.path;
      setDragOverPath(path);
      if (currentDragOverRef.current !== path) {
        if (dragExpandTimerRef.current) clearTimeout(dragExpandTimerRef.current);
        currentDragOverRef.current = path;
        if (overData.node.type === "folder" || overData.node.type === "object") {
          dragExpandTimerRef.current = setTimeout(() => {
            if (currentDragOverRef.current !== path) return;
            setExpandedPaths((prev) => {
              if (prev.has(path)) return prev;
              const next = new Set(prev);
              next.add(path);
              return next;
            });
          }, 300);
        }
      }
    } else {
      if (dragExpandTimerRef.current) clearTimeout(dragExpandTimerRef.current);
      currentDragOverRef.current = null;
      setDragOverPath(null);
    }
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveNode(null);
      setDragOverPath(null);
      if (dragExpandTimerRef.current) clearTimeout(dragExpandTimerRef.current);
      currentDragOverRef.current = null;
      removePointerTracker();

      const activeData = event.active.data.current as { node: TreeNode } | undefined;

      if (!activeData?.node) {return;}

      const source = activeData.node;

      // Check for external drop targets FIRST (e.g. chat input).
      // closestCenter always returns a droppable even when the pointer is
      // far outside the tree, so we can't rely on `event.over === null`.
      if (onExternalDrop) {
        const { x, y } = pointerPosRef.current;
        const el = document.elementFromPoint(x, y);
        if (el?.closest("[data-chat-drop-target]")) {
          onExternalDrop(source);
          return;
        }
      }

      const overData = event.over?.data.current as { node?: TreeNode; rootDrop?: boolean } | undefined;

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

      if (!overData?.node) {return;}

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
    [onRefresh, onExternalDrop, removePointerTracker],
  );

  const handleDragCancel = useCallback(() => {
    setActiveNode(null);
    setDragOverPath(null);
    if (dragExpandTimerRef.current) clearTimeout(dragExpandTimerRef.current);
    currentDragOverRef.current = null;
    removePointerTracker();
  }, [removePointerTracker]);

  // Context menu handlers — first (deepest) node wins per event
  const handleContextMenu = useCallback((e: React.MouseEvent, node: TreeNode) => {
    if (ctxEventIdRef.current === e.timeStamp) return;
    ctxEventIdRef.current = e.timeStamp;
    const isSys = isSystemFile(node.path, workspaceRoot) || isVirtualNode(node);
    const isFolder = node.type === "folder" || node.type === "object";
    setCtxTarget({
      kind: isFolder ? "folder" : "file",
      path: node.path,
      name: node.name,
      isSystem: isSys,
    });
  }, [workspaceRoot]);

  const handleEmptyContextMenu = useCallback((e: React.MouseEvent) => {
    if (ctxEventIdRef.current === e.timeStamp) return;
    ctxEventIdRef.current = e.timeStamp;
    setCtxTarget({ kind: "empty" });
  }, []);

  const handleContextMenuAction = useCallback(
    async (action: ContextMenuAction) => {
      const target = ctxTarget;
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
            await navigator.clipboard.writeText(toLocalClipboardPath(target.path, workspaceRoot));
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
            await navigator.clipboard.writeText(toLocalClipboardPath(target.path, workspaceRoot));
          }
          break;
        }
      }
    },
    [ctxTarget, tree, onSelect, onRefresh, workspaceRoot],
  );

  // Rename handlers
  const handleCommitRename = useCallback(
    async (newName: string) => {
      if (!renamingPath) {return;}
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
            const curProtected = isSystemFile(curNode.path, workspaceRoot) || isVirtualNode(curNode);
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
          if (curNode && !isSystemFile(curNode.path, workspaceRoot) && !isVirtualNode(curNode)) {
            setRenamingPath(curNode.path);
          }
          break;
        }
        case "Backspace":
        case "Delete": {
          if (curNode && !isSystemFile(curNode.path, workspaceRoot) && !isVirtualNode(curNode)) {
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
              void navigator.clipboard.writeText(toLocalClipboardPath(curNode.path, workspaceRoot));
            } else if (e.key === "d" && curNode && !isSystemFile(curNode.path, workspaceRoot)) {
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
    [tree, expandedPaths, selectedPath, renamingPath, onSelect, onRefresh, workspaceRoot],
  );

  if (tree.length === 0) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="px-4 py-6 text-center text-sm"
            style={{ color: "var(--color-text-muted)" }}
            onContextMenu={handleEmptyContextMenu}
          >
            No files in workspace
          </div>
        </ContextMenuTrigger>
        <FileContextMenuContent target={ctxTarget} onAction={handleContextMenuAction} />
        {newItemPrompt && (
          <NewItemPrompt
            kind={newItemPrompt.kind}
            parentPath={newItemPrompt.parentPath}
            onSubmit={handleNewItemSubmit}
            onCancel={() => setNewItemPrompt(null)}
          />
        )}
      </ContextMenu>
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
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={containerRef}
            className="py-1 outline-none flex flex-col min-h-full"
            tabIndex={0}
            role="tree"
            onKeyDown={handleKeyDown}
            onContextMenu={handleEmptyContextMenu}
          >
            {parentDir != null && onNavigateUp && (
              <div
                role="treeitem"
                tabIndex={-1}
                onClick={onNavigateUp}
                className="w-full flex items-center gap-2 py-1.5 px-2 rounded-xl text-left text-sm transition-all duration-100 cursor-pointer select-none"
                style={{
                  paddingLeft: "14px",
                  color: "var(--color-text-muted)",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "transparent";
                }}
              >
                <span className="flex-shrink-0 flex items-center" style={{ opacity: 0.55 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                </span>
                <span className="truncate flex-1">Back</span>
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
        </ContextMenuTrigger>
        <FileContextMenuContent target={ctxTarget} onAction={handleContextMenuAction} />
      </ContextMenu>

      {/* Drag overlay (ghost) — pointer-events:none so elementFromPoint sees through it */}
      <DragOverlay dropAnimation={null} style={{ pointerEvents: "none" }}>
        {activeNode ? <DragOverlayContent node={activeNode} /> : null}
      </DragOverlay>

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

// --- Radix context menu content for file tree ---

function FileContextMenuContent({
  target,
  onAction,
}: {
  target: ContextMenuTarget;
  onAction: (action: ContextMenuAction) => void;
}) {
  const items = getMenuItems(target);
  const isSystem = target.kind !== "empty" && target.isSystem;

  return (
    <ContextMenuContent className="min-w-[200px]">
      {isSystem && (
        <div
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px]"
          style={{ color: "var(--color-text-muted)" }}
        >
          <LockIcon />
          <span>System file (locked)</span>
        </div>
      )}
      {items.map((item, i) => {
        if ("separator" in item && item.separator) {
          return <ContextMenuSeparator key={`sep-${i}`} />;
        }
        return (
          <ContextMenuItem
            key={item.action}
            variant={item.danger ? "destructive" : "default"}
            disabled={item.disabled}
            onSelect={() => onAction(item.action)}
          >
            {item.icon}
            <span className="flex-1">{item.label}</span>
            {item.disabled && isSystem && <LockIcon />}
            {item.shortcut && (
              <ContextMenuShortcut>{item.shortcut}</ContextMenuShortcut>
            )}
          </ContextMenuItem>
        );
      })}
    </ContextMenuContent>
  );
}
