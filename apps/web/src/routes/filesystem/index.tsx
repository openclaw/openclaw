"use client";

import * as React from "react";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/stores/useUIStore";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
import { RouteErrorFallback } from "@/components/composed";
  FolderOpen,
  Folder,
  File,
  FileText,
  FileJson,
  FileCode,
  ChevronRight,
  ChevronDown,
  Download,
  Trash2,
  Edit2,
  Save,
  X,
  HardDrive,
} from "lucide-react";

export const Route = createFileRoute("/filesystem/")({
  component: FilesystemPage,
  errorComponent: RouteErrorFallback,
});

// Mock filesystem structure representing ~/.clawdbrain/
interface FileNode {
  id: string;
  name: string;
  type: "file" | "folder";
  path: string;
  children?: FileNode[];
  size?: number;
  content?: string;
  lastModified?: Date;
}

const mockFileSystem: FileNode = {
  id: "root",
  name: ".clawdbrain",
  type: "folder",
  path: "~/.clawdbrain",
  children: [
    {
      id: "config",
      name: "config",
      type: "folder",
      path: "~/.clawdbrain/config",
      children: [
        {
          id: "config-json",
          name: "config.json",
          type: "file",
          path: "~/.clawdbrain/config/config.json",
          size: 2048,
          lastModified: new Date(Date.now() - 86400000),
          content: JSON.stringify(
            {
              version: "1.0.0",
              theme: "dark",
              language: "en",
              notifications: true,
              autoSync: true,
              apiEndpoint: "https://api.secondbrain.dev",
            },
            null,
            2
          ),
        },
        {
          id: "agents-json",
          name: "agents.json",
          type: "file",
          path: "~/.clawdbrain/config/agents.json",
          size: 4096,
          lastModified: new Date(Date.now() - 3600000),
          content: JSON.stringify(
            {
              agents: [
                { id: "1", name: "Research Assistant", active: true },
                { id: "2", name: "Code Companion", active: true },
              ],
            },
            null,
            2
          ),
        },
      ],
    },
    {
      id: "sessions",
      name: "sessions",
      type: "folder",
      path: "~/.clawdbrain/sessions",
      children: [
        {
          id: "session-1",
          name: "session-2024-01-15.jsonl",
          type: "file",
          path: "~/.clawdbrain/sessions/session-2024-01-15.jsonl",
          size: 15360,
          lastModified: new Date(Date.now() - 172800000),
          content:
            '{"type":"message","role":"user","content":"Hello"}\n{"type":"message","role":"assistant","content":"Hi there!"}\n{"type":"message","role":"user","content":"How are you?"}',
        },
        {
          id: "session-2",
          name: "session-2024-01-20.jsonl",
          type: "file",
          path: "~/.clawdbrain/sessions/session-2024-01-20.jsonl",
          size: 8192,
          lastModified: new Date(Date.now() - 43200000),
          content:
            '{"type":"message","role":"user","content":"Start a new task"}\n{"type":"message","role":"assistant","content":"Sure, what would you like to do?"}',
        },
      ],
    },
    {
      id: "logs",
      name: "logs",
      type: "folder",
      path: "~/.clawdbrain/logs",
      children: [
        {
          id: "app-log",
          name: "app.log",
          type: "file",
          path: "~/.clawdbrain/logs/app.log",
          size: 51200,
          lastModified: new Date(),
          content:
            "[2024-01-20 10:00:00] INFO: Application started\n[2024-01-20 10:00:01] DEBUG: Loading configuration\n[2024-01-20 10:00:02] INFO: Connected to database\n[2024-01-20 10:00:03] WARN: Cache miss for key 'user-prefs'\n[2024-01-20 10:00:04] INFO: User authenticated successfully",
        },
        {
          id: "error-log",
          name: "error.log",
          type: "file",
          path: "~/.clawdbrain/logs/error.log",
          size: 2048,
          lastModified: new Date(Date.now() - 7200000),
          content:
            "[2024-01-20 08:15:00] ERROR: Failed to connect to remote server\n[2024-01-20 09:30:00] ERROR: Timeout waiting for response",
        },
      ],
    },
    {
      id: "credentials",
      name: "credentials",
      type: "folder",
      path: "~/.clawdbrain/credentials",
      children: [
        {
          id: "api-keys",
          name: "api-keys.enc",
          type: "file",
          path: "~/.clawdbrain/credentials/api-keys.enc",
          size: 512,
          lastModified: new Date(Date.now() - 604800000),
          content: "[encrypted content]",
        },
      ],
    },
    {
      id: "readme",
      name: "README.md",
      type: "file",
      path: "~/.clawdbrain/README.md",
      size: 1024,
      lastModified: new Date(Date.now() - 2592000000),
      content:
        "# Second Brain Configuration\n\nThis directory contains your Second Brain configuration and data.\n\n## Structure\n\n- `config/` - Configuration files\n- `sessions/` - Session logs\n- `logs/` - Application logs\n- `credentials/` - Encrypted credentials\n\n## Important\n\nDo not manually edit files in the `credentials/` directory.",
    },
  ],
};

function FilesystemPage() {
  const powerUserMode = useUIStore((s) => s.powerUserMode);
  const [selectedFile, setSelectedFile] = React.useState<FileNode | null>(null);
  const [expandedFolders, setExpandedFolders] = React.useState<Set<string>>(
    new Set(["root"])
  );
  const [isEditing, setIsEditing] = React.useState(false);
  const [editContent, setEditContent] = React.useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);
  const [fileToDelete, setFileToDelete] = React.useState<FileNode | null>(null);

  if (!powerUserMode) {
    return <Navigate to="/" />;
  }

  const toggleFolder = (id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleFileClick = (file: FileNode) => {
    if (file.type === "folder") {
      toggleFolder(file.id);
    } else {
      setSelectedFile(file);
      setIsEditing(false);
      setEditContent(file.content || "");
    }
  };

  const handleEdit = () => {
    if (selectedFile) {
      setEditContent(selectedFile.content || "");
      setIsEditing(true);
    }
  };

  const handleSave = () => {
    // In a real app, this would save to the filesystem
    console.log("Saving file:", selectedFile?.path, editContent);
    setIsEditing(false);
  };

  const handleDownload = () => {
    if (!selectedFile) {return;}
    const blob = new Blob([selectedFile.content || ""], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = selectedFile.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDelete = () => {
    if (fileToDelete) {
      console.log("Deleting file:", fileToDelete.path);
      setDeleteDialogOpen(false);
      setFileToDelete(null);
      if (selectedFile?.id === fileToDelete.id) {
        setSelectedFile(null);
      }
    }
  };

  const confirmDelete = (file: FileNode) => {
    setFileToDelete(file);
    setDeleteDialogOpen(true);
  };

  const getFileIcon = (file: FileNode) => {
    if (file.type === "folder") {
      return expandedFolders.has(file.id) ? (
        <FolderOpen className="h-4 w-4 text-yellow-500" />
      ) : (
        <Folder className="h-4 w-4 text-yellow-500" />
      );
    }

    const ext = file.name.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "json":
      case "jsonl":
        return <FileJson className="h-4 w-4 text-orange-500" />;
      case "md":
        return <FileText className="h-4 w-4 text-blue-500" />;
      case "log":
        return <FileCode className="h-4 w-4 text-green-500" />;
      case "enc":
        return <File className="h-4 w-4 text-red-500" />;
      default:
        return <File className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) {return `${bytes} B`;}
    if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`;}
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const renderTree = (node: FileNode, depth = 0) => {
    const isExpanded = expandedFolders.has(node.id);
    const isSelected = selectedFile?.id === node.id;

    return (
      <div key={node.id}>
        <button
          type="button"
          onClick={() => handleFileClick(node)}
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left text-sm transition-colors",
            "hover:bg-muted",
            isSelected && "bg-primary/10 text-primary"
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          {node.type === "folder" && (
            <span className="w-4 flex items-center justify-center">
              {isExpanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </span>
          )}
          {node.type === "file" && <span className="w-4" />}
          {getFileIcon(node)}
          <span className="flex-1 truncate">{node.name}</span>
          {node.type === "file" && node.size && (
            <span className="text-xs text-muted-foreground">
              {formatSize(node.size)}
            </span>
          )}
        </button>

        {node.type === "folder" && isExpanded && node.children && (
          <AnimatePresence>
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
            >
              {node.children.map((child) => renderTree(child, depth + 1))}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    );
  };

  const renderFileContent = () => {
    if (!selectedFile) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
          <File className="h-12 w-12 mb-4" />
          <p>Select a file to preview</p>
        </div>
      );
    }

    const ext = selectedFile.name.split(".").pop()?.toLowerCase();
    const content = isEditing ? editContent : selectedFile.content || "";

    // Render markdown
    if (ext === "md" && !isEditing) {
      return (
        <div className="prose prose-sm dark:prose-invert max-w-none p-4">
          {content.split("\n").map((line, i) => {
            if (line.startsWith("# ")) {
              return (
                <h1 key={i} className="text-2xl font-bold mb-4">
                  {line.slice(2)}
                </h1>
              );
            }
            if (line.startsWith("## ")) {
              return (
                <h2 key={i} className="text-xl font-semibold mb-3 mt-6">
                  {line.slice(3)}
                </h2>
              );
            }
            if (line.startsWith("- ")) {
              return (
                <li key={i} className="ml-4">
                  {line.slice(2)}
                </li>
              );
            }
            if (line.trim() === "") {
              return <br key={i} />;
            }
            return (
              <p key={i} className="mb-2">
                {line}
              </p>
            );
          })}
        </div>
      );
    }

    // Render JSON with formatting
    if ((ext === "json" || ext === "jsonl") && !isEditing) {
      try {
        const formatted =
          ext === "jsonl"
            ? content
                .split("\n")
                .map((line) => {
                  try {
                    return JSON.stringify(JSON.parse(line), null, 2);
                  } catch {
                    return line;
                  }
                })
                .join("\n---\n")
            : JSON.stringify(JSON.parse(content), null, 2);
        return (
          <pre className="p-4 text-sm font-mono whitespace-pre-wrap text-primary">
            {formatted}
          </pre>
        );
      } catch {
        // Fall through to raw display
      }
    }

    // Raw text / editing mode
    if (isEditing) {
      return (
        <Textarea
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          className="w-full h-full min-h-[400px] font-mono text-sm resize-none border-0 focus-visible:ring-0"
        />
      );
    }

    return (
      <pre className="p-4 text-sm font-mono whitespace-pre-wrap">{content}</pre>
    );
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mb-8"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
              <HardDrive className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-foreground">
                Filesystem
              </h1>
              <p className="text-muted-foreground">
                Browse and manage configuration files
              </p>
            </div>
          </div>
        </motion.div>

        {/* Main Content */}
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          {/* File Tree */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Files</CardTitle>
              <CardDescription>~/.clawdbrain</CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px]">
                {renderTree(mockFileSystem)}
              </ScrollArea>
            </CardContent>
          </Card>

          {/* File Preview */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg">
                    {selectedFile ? selectedFile.name : "Preview"}
                  </CardTitle>
                  {selectedFile && (
                    <CardDescription>{selectedFile.path}</CardDescription>
                  )}
                </div>
                {selectedFile && (
                  <div className="flex items-center gap-2">
                    {isEditing ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setIsEditing(false)}
                          className="gap-1"
                        >
                          <X className="h-3 w-3" />
                          Cancel
                        </Button>
                        <Button size="sm" onClick={handleSave} className="gap-1">
                          <Save className="h-3 w-3" />
                          Save
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleEdit}
                          className="gap-1"
                        >
                          <Edit2 className="h-3 w-3" />
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleDownload}
                          className="gap-1"
                        >
                          <Download className="h-3 w-3" />
                          Download
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => confirmDelete(selectedFile)}
                          className="gap-1 text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-3 w-3" />
                          Delete
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
              {selectedFile && (
                <div className="flex items-center gap-3 mt-2">
                  <Badge variant="secondary">
                    {formatSize(selectedFile.size || 0)}
                  </Badge>
                  {selectedFile.lastModified && (
                    <span className="text-xs text-muted-foreground">
                      Modified{" "}
                      {selectedFile.lastModified.toLocaleDateString()}
                    </span>
                  )}
                </div>
              )}
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[440px] rounded-lg border bg-muted/30">
                {renderFileContent()}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>

        {/* Delete Confirmation Dialog */}
        <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete File</DialogTitle>
              <DialogDescription>
                Are you sure you want to delete{" "}
                <span className="font-medium text-foreground">
                  {fileToDelete?.name}
                </span>
                ? This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setDeleteDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleDelete}>
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
