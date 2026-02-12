"use client";

import { useState, useCallback } from "react";

export type TreeNode = {
  name: string;
  path: string;
  type: "object" | "document" | "folder" | "file" | "database";
  icon?: string;
  defaultView?: "table" | "kanban";
  children?: TreeNode[];
};

// --- Icons (inline SVG for zero-dep) ---

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
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5V19A9 3 0 0 0 21 19V5" />
      <path d="M3 12A9 3 0 0 0 21 12" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
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
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 150ms ease",
      }}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

// --- Node Icon Resolver ---

function NodeIcon({ node, open }: { node: TreeNode; open?: boolean }) {
  switch (node.type) {
    case "object":
      return node.defaultView === "kanban" ? <KanbanIcon /> : <TableIcon />;
    case "document":
      return <DocumentIcon />;
    case "folder":
      return <FolderIcon open={open} />;
    case "database":
      return <DatabaseIcon />;
    default:
      return <FileIcon />;
  }
}

// --- Tree Node Component ---

function TreeNodeItem({
  node,
  depth,
  activePath,
  onSelect,
  expandedPaths,
  onToggleExpand,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  onSelect: (node: TreeNode) => void;
  expandedPaths: Set<string>;
  onToggleExpand: (path: string) => void;
}) {
  const hasChildren = node.children && node.children.length > 0;
  const isExpandable = hasChildren || node.type === "folder" || node.type === "object";
  const isExpanded = expandedPaths.has(node.path);
  const isActive = activePath === node.path;

  const handleClick = () => {
    onSelect(node);
    if (isExpandable) {
      onToggleExpand(node.path);
    }
  };

  const typeColor =
    node.type === "object"
      ? "var(--color-accent)"
      : node.type === "document"
        ? "#60a5fa"
        : node.type === "database"
          ? "#c084fc"
          : "var(--color-text-muted)";

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        className="w-full flex items-center gap-1.5 py-1 px-2 rounded-md text-left text-sm transition-colors duration-100 cursor-pointer"
        style={{
          paddingLeft: `${depth * 16 + 8}px`,
          background: isActive ? "var(--color-surface-hover)" : "transparent",
          color: isActive ? "var(--color-text)" : "var(--color-text-muted)",
        }}
        onMouseEnter={(e) => {
          if (!isActive)
            {(e.currentTarget as HTMLElement).style.background =
              "var(--color-surface-hover)";}
        }}
        onMouseLeave={(e) => {
          if (!isActive)
            {(e.currentTarget as HTMLElement).style.background = "transparent";}
        }}
      >
        {/* Expand/collapse chevron */}
        <span
          className="flex-shrink-0 w-4 h-4 flex items-center justify-center"
          style={{ opacity: isExpandable ? 1 : 0 }}
        >
          {isExpandable && <ChevronIcon open={isExpanded} />}
        </span>

        {/* Icon */}
        <span
          className="flex-shrink-0 flex items-center"
          style={{ color: typeColor }}
        >
          <NodeIcon node={node} open={isExpanded} />
        </span>

        {/* Label */}
        <span className="truncate flex-1">
          {node.name.replace(/\.md$/, "")}
        </span>

        {/* Type badge for objects */}
        {node.type === "object" && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0"
            style={{
              background: "rgba(232, 93, 58, 0.15)",
              color: "var(--color-accent)",
            }}
          >
            {node.defaultView === "kanban" ? "board" : "table"}
          </span>
        )}
      </button>

      {/* Children */}
      {isExpanded && hasChildren && (
        <div
          className="relative"
          style={{
            borderLeft: depth > 0 ? "1px solid var(--color-border)" : "none",
            marginLeft: `${depth * 16 + 16}px`,
          }}
        >
          {node.children!.map((child) => (
            <TreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onSelect={onSelect}
              expandedPaths={expandedPaths}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Exported Tree Component ---

export function KnowledgeTree({
  tree,
  activePath,
  onSelect,
}: {
  tree: TreeNode[];
  activePath: string | null;
  onSelect: (node: TreeNode) => void;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(),
  );

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {next.delete(path);}
      else {next.add(path);}
      return next;
    });
  }, []);

  if (tree.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>
        No files in workspace
      </div>
    );
  }

  return (
    <div className="py-1">
      {tree.map((node) => (
        <TreeNodeItem
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          onSelect={onSelect}
          expandedPaths={expandedPaths}
          onToggleExpand={handleToggleExpand}
        />
      ))}
    </div>
  );
}
