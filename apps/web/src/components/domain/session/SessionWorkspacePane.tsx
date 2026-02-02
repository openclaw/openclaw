"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { WebTerminalRef } from "@/components/composed/WebTerminal";
import {
  Maximize2,
  Minimize2,
  Terminal,
  FolderOpen,
  RefreshCw,
  ChevronDown,
  Loader2,
} from "lucide-react";
import { FilePreviewPanel } from "./FilePreviewPanel";
import { createWorktreeGatewayAdapter } from "@/integrations/worktree/gateway";

// Lazy-load WebTerminal and all xterm dependencies
const LazyWebTerminal = React.lazy(() =>
  import("@/components/composed/WebTerminal").then((mod) => ({
    default: mod.WebTerminal,
  }))
);

export interface SessionWorkspacePaneProps {
  /** Whether the pane is maximized */
  isMaximized?: boolean;
  /** Callback to toggle maximize state */
  onToggleMaximize?: () => void;
  /** Agent workspace directory path */
  workspaceDir?: string;
  /** Session key for terminal context */
  sessionKey?: string;
  /** Agent ID for file operations */
  agentId?: string;
  /** Callback when terminal receives data */
  onTerminalData?: (data: string) => void;
  /** Additional CSS classes */
  className?: string;
}

// Mock file tree for development
interface FileNode {
  name: string;
  type: "file" | "folder";
  children?: FileNode[];
}

const mockFileTree: FileNode[] = [
  {
    name: "workspace",
    type: "folder",
    children: [
      { name: "README.md", type: "file" },
      { name: "notes.txt", type: "file" },
      {
        name: "research",
        type: "folder",
        children: [
          { name: "findings.md", type: "file" },
          { name: "data.json", type: "file" },
        ],
      },
      {
        name: "scripts",
        type: "folder",
        children: [
          { name: "analyze.py", type: "file" },
          { name: "export.sh", type: "file" },
        ],
      },
    ],
  },
];

export function SessionWorkspacePane({
  isMaximized = false,
  onToggleMaximize,
  workspaceDir = "~/.clawdbrain/agents/default/workspace",
  sessionKey,
  agentId,
  onTerminalData,
  className,
}: SessionWorkspacePaneProps) {
  const terminalRef = React.useRef<WebTerminalRef>(null);
  const [activeTab, setActiveTab] = React.useState<"terminal" | "files">("files");
  const [filesRevision, setFilesRevision] = React.useState(0);
  const [portalTarget, setPortalTarget] = React.useState<HTMLElement | null>(null);
  const [overlayTop, setOverlayTop] = React.useState(112);
  const [overlayBottom, setOverlayBottom] = React.useState(12);

  // File preview state
  const [selectedFile, setSelectedFile] = React.useState<FileNode & { path: string } | null>(null);
  const [fileContent, setFileContent] = React.useState<string>("");
  const [fileLoading, setFileLoading] = React.useState(false);
  const [fileError, setFileError] = React.useState<string | null>(null);

  // Worktree adapter for file operations (uses gateway WebSocket client)
  const worktreeAdapter = React.useMemo(() => createWorktreeGatewayAdapter(), []);

  // Handle terminal resize when maximized state changes
  React.useEffect(() => {
    if (terminalRef.current) {
      // Give time for layout to settle
      const timer = setTimeout(() => {
        terminalRef.current?.fit();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isMaximized]);

  React.useEffect(() => {
    if (typeof document === "undefined") {return;}
    setPortalTarget(document.body);
  }, []);

  React.useLayoutEffect(() => {
    if (!isMaximized) {return;}

    const updateBounds = () => {
      const nudge = document.querySelector<HTMLElement>("[data-approval-nudge]");
      const nudgeBottom = nudge ? nudge.getBoundingClientRect().bottom : 0;
      const nextTop = Math.max(16, Math.round(nudgeBottom + 12));
      setOverlayTop(nextTop);
      setOverlayBottom(Math.round(window.innerHeight * 0.12));
    };

    updateBounds();
    window.addEventListener("resize", updateBounds);
    return () => window.removeEventListener("resize", updateBounds);
  }, [isMaximized]);

  const handleRefreshFiles = () => {
    setFilesRevision((prev) => prev + 1);
  };

  const handleFileClick = React.useCallback(async (node: FileNode, path: string) => {
    if (node.type === "folder") {return;}

    setSelectedFile({ ...node, path });
    setFileLoading(true);
    setFileError(null);

    if (!agentId) {
      setFileError("Agent ID not available");
      setFileLoading(false);
      return;
    }

    try {
      const result = await worktreeAdapter.readFile?.(
        agentId,
        path,
        { signal: new AbortController().signal }
      );
      setFileContent(result?.content || "");
    } catch (err) {
      console.error("Failed to load file:", err);

      const errorMessage = err instanceof Error ? err.message : String(err);

      // Provide specific error messages for common cases
      if (errorMessage.includes("Not connected to gateway")) {
        setFileError("Not connected to gateway. Please ensure the gateway is running and connected.");
      } else if (errorMessage.includes("Request failed") || errorMessage.includes("timeout")) {
        setFileError("File preview API not yet implemented. The gateway backend needs to implement the 'worktree.read' RPC method.");
      } else if (errorMessage.includes("<!doctype") || errorMessage.includes("is not valid JSON")) {
        setFileError("File preview API not yet implemented. The worktree API endpoints need to be added to the gateway backend.");
      } else {
        setFileError(errorMessage || "Failed to load file");
      }
    } finally {
      setFileLoading(false);
    }
  }, [agentId, worktreeAdapter]);

  // Clear selection when panel is minimized
  React.useEffect(() => {
    if (!isMaximized) {
      setSelectedFile(null);
      setFileContent("");
      setFileError(null);
    }
  }, [isMaximized]);

  const pane = (
    <div
      className={cn(
        "flex flex-col border border-border rounded-xl bg-card overflow-hidden",
        isMaximized && "fixed inset-x-4 bottom-24 top-20 z-50 shadow-2xl",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-2">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "terminal" | "files")}>
          <TabsList className="h-8 bg-transparent p-0">
            <TabsTrigger
              value="files"
              className="h-7 px-3 text-xs data-[state=active]:bg-background"
            >
              <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
              Files
            </TabsTrigger>
            <TabsTrigger
              value="terminal"
              className="h-7 px-3 text-xs data-[state=active]:bg-background"
            >
              <Terminal className="h-3.5 w-3.5 mr-1.5" />
              Terminal
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-1">
          {activeTab === "files" && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleRefreshFiles}
              title="Refresh files"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          )}
          {onToggleMaximize && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onToggleMaximize}
              title={isMaximized ? "Minimize" : "Maximize"}
            >
              {isMaximized ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {activeTab === "terminal" ? (
          <React.Suspense
            fallback={
              <div className="flex h-full items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  <div className="text-sm text-muted-foreground">Loading terminal...</div>
                </div>
              </div>
            }
          >
            <LazyWebTerminal
              ref={terminalRef}
              className="h-full rounded-none border-none"
              height="100%"
              welcomeMessage={`Clawdbrain Terminal\nSession: ${sessionKey ?? "none"}\nWorkspace: ${workspaceDir}\n`}
              onData={onTerminalData}
            />
          </React.Suspense>
        ) : (
          <div className={cn(
            "h-full",
            isMaximized && selectedFile && "grid grid-cols-[35%_65%] gap-0"
          )}>
            <div className={cn(
              "h-full overflow-auto",
              isMaximized && selectedFile && "border-r border-border"
            )}>
              <FileExplorer
                key={filesRevision}
                files={mockFileTree}
                workspaceDir={workspaceDir}
                onFileClick={handleFileClick}
                selectedPath={selectedFile?.path}
              />
            </div>

            {isMaximized && selectedFile && (
              <FilePreviewPanel
                file={selectedFile}
                content={fileContent}
                loading={fileLoading}
                error={fileError}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );

  if (isMaximized && portalTarget) {
    return createPortal(
      <div
        className="fixed z-50 w-[60vw] max-w-[60vw] left-1/2 -translate-x-1/2"
        style={{ top: overlayTop, bottom: overlayBottom }}
      >
        {pane}
      </div>,
      portalTarget
    );
  }

  return pane;
}

interface FileExplorerProps {
  files: FileNode[];
  workspaceDir: string;
  onFileClick?: (node: FileNode, path: string) => void;
  selectedPath?: string;
}

function FileExplorer({ files, workspaceDir, onFileClick, selectedPath }: FileExplorerProps) {
  return (
    <div className="h-full overflow-auto p-3 scrollbar-thin">
      {/* Workspace path */}
      <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
        <FolderOpen className="h-3.5 w-3.5" />
        <span className="font-mono truncate">{workspaceDir}</span>
      </div>

      {/* File tree */}
      <div className="space-y-1">
        {files.map((node) => (
          <FileTreeNode
            key={node.name}
            node={node}
            depth={0}
            parentPath=""
            onFileClick={onFileClick}
            selectedPath={selectedPath}
          />
        ))}
      </div>
    </div>
  );
}

interface FileTreeNodeProps {
  node: FileNode;
  depth: number;
  parentPath: string;
  onFileClick?: (node: FileNode, path: string) => void;
  selectedPath?: string;
}

function FileTreeNode({ node, depth, parentPath, onFileClick, selectedPath }: FileTreeNodeProps) {
  const [isExpanded, setIsExpanded] = React.useState(true);
  const isFolder = node.type === "folder";
  const currentPath = parentPath ? `${parentPath}/${node.name}` : node.name;
  const isSelected = selectedPath === currentPath;

  const handleClick = () => {
    if (isFolder) {
      setIsExpanded(!isExpanded);
    } else {
      onFileClick?.(node, currentPath);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors",
          "hover:bg-muted/50",
          isSelected && "bg-accent",
          "cursor-pointer"
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {isFolder ? (
          <>
            <ChevronDown
              className={cn(
                "h-3 w-3 text-muted-foreground transition-transform",
                !isExpanded && "-rotate-90"
              )}
            />
            <FolderOpen className="h-3.5 w-3.5 text-yellow-500" />
          </>
        ) : (
          <>
            <span className="w-3" />
            <FileIcon filename={node.name} />
          </>
        )}
        <span className="truncate">{node.name}</span>
      </button>

      {isFolder && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.name}
              node={child}
              depth={depth + 1}
              parentPath={currentPath}
              onFileClick={onFileClick}
              selectedPath={selectedPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FileIcon({ filename }: { filename: string }) {
  const ext = filename.split(".").pop()?.toLowerCase();

  const iconClass = "h-3.5 w-3.5";

  switch (ext) {
    case "md":
      return <span className={cn(iconClass, "text-blue-400")}>📄</span>;
    case "json":
      return <span className={cn(iconClass, "text-yellow-400")}>📋</span>;
    case "py":
      return <span className={cn(iconClass, "text-green-400")}>🐍</span>;
    case "sh":
      return <span className={cn(iconClass, "text-gray-400")}>⚡</span>;
    case "txt":
      return <span className={cn(iconClass, "text-gray-400")}>📝</span>;
    default:
      return <span className={cn(iconClass, "text-gray-400")}>📄</span>;
  }
}

export default SessionWorkspacePane;
