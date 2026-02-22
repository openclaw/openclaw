"use client";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from "react";
import {
  Paperclip,
  X,
  Image as ImageIcon,
  FileText,
  FileCode2,
  File as LucideFile,
  Braces,
  Code2,
  FileCode,
  Palette,
  FileJson,
  Terminal,
  Database,
  Film,
  Archive,
  Upload,
  FolderOpen,
  ChevronRight,
  Loader2,
  AlertCircle,
  AtSign,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  type FileAttachment,
  type FileCategory,
  processFile,
  validateFile,
  formatFileSize,
  getFileIcon,
  buildAcceptString,
  getFilesFromClipboard,
  getFilesFromDrag,
} from "@/lib/file-utils";

// ========== Types ==========

export interface FileAttachmentsRef {
  /** Get all ready attachments */
  getAttachments: () => FileAttachment[];
  /** Clear all attachments */
  clear: () => void;
  /** Add files programmatically */
  addFiles: (files: File[]) => Promise<void>;
  /** Check if there are any attachments */
  hasAttachments: () => boolean;
}

interface FileAttachmentsProps {
  /** Callback when attachments change */
  onAttachmentsChange?: (attachments: FileAttachment[]) => void;
  /** Whether input is disabled */
  disabled?: boolean;
  /** Maximum number of attachments */
  maxAttachments?: number;
  /** Show the @ file browser */
  showFileBrowser?: boolean;
  /** Callback to open file browser */
  onOpenFileBrowser?: () => void;
  /** Class name for the container */
  className?: string;
}

interface LocalFile {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  children?: LocalFile[];
}

// ========== Icon Component ==========

function FileIcon({
  category,
  filename,
  className = "w-4 h-4",
}: {
  category: FileCategory;
  filename?: string;
  className?: string;
}) {
  const iconName = getFileIcon(category, filename);
  const iconMap: Record<string, typeof LucideFile> = {
    Image: ImageIcon,
    FileText: FileText,
    FileCode2: FileCode2,
    File: LucideFile,
    Braces: Braces,
    Code2: Code2,
    FileCode: FileCode,
    Palette: Palette,
    FileJson: FileJson,
    Terminal: Terminal,
    Database: Database,
    Film: Film,
    Archive: Archive,
  };
  const Icon = iconMap[iconName] || LucideFile;
  return <Icon className={className} />;
}

// ========== Main Component ==========

export const FileAttachments = forwardRef<FileAttachmentsRef, FileAttachmentsProps>(
  function FileAttachments(
    {
      onAttachmentsChange,
      disabled = false,
      maxAttachments = 10,
      showFileBrowser = true,
      onOpenFileBrowser,
      className = "",
    },
    ref
  ) {
    const [attachments, setAttachments] = useState<FileAttachment[]>([]);
    const [isDragging, setIsDragging] = useState(false);
    const [showLocalBrowser, setShowLocalBrowser] = useState(false);
    const [localFiles, setLocalFiles] = useState<LocalFile[]>([]);
    const [localPath, setLocalPath] = useState<string[]>([]);
    const [loadingLocal, setLoadingLocal] = useState(false);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const dropZoneRef = useRef<HTMLDivElement>(null);
    const dragCountRef = useRef(0);

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
      getAttachments: () => attachments.filter((a) => a.status === "ready"),
      clear: () => {
        setAttachments([]);
        onAttachmentsChange?.([]);
      },
      addFiles: async (files: File[]) => {
        await handleFiles(files);
      },
      hasAttachments: () => attachments.some((a) => a.status === "ready"),
    }));

    // Notify parent of changes
    useEffect(() => {
      onAttachmentsChange?.(attachments);
    }, [attachments, onAttachmentsChange]);

    // Process and add files
    const handleFiles = useCallback(
      async (files: File[]) => {
        const currentCount = attachments.length;
        const remaining = maxAttachments - currentCount;

        if (remaining <= 0) {return;}

        const filesToProcess = files.slice(0, remaining);

        // Add files as pending
        const pendingAttachments: FileAttachment[] = filesToProcess.map((file) => ({
          id: `pending_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          file,
          name: file.name,
          size: file.size,
          type: file.type,
          category: "unknown" as FileCategory,
          status: "pending" as const,
        }));

        setAttachments((prev) => [...prev, ...pendingAttachments]);

        // Process each file
        for (let i = 0; i < filesToProcess.length; i++) {
          const file = filesToProcess[i];
          const pendingId = pendingAttachments[i].id;

          const validation = validateFile(file);
          if (!validation.valid) {
            setAttachments((prev) =>
              prev.map((a) =>
                a.id === pendingId
                  ? { ...a, status: "error" as const, error: validation.error }
                  : a
              )
            );
            continue;
          }

          try {
            const processed = await processFile(file);
            setAttachments((prev) =>
              prev.map((a) => (a.id === pendingId ? { ...processed, id: pendingId } : a))
            );
          } catch (error) {
            setAttachments((prev) =>
              prev.map((a) =>
                a.id === pendingId
                  ? {
                      ...a,
                      status: "error" as const,
                      error: error instanceof Error ? error.message : "Processing failed",
                    }
                  : a
              )
            );
          }
        }
      },
      [attachments.length, maxAttachments]
    );

    // Remove attachment
    const removeAttachment = useCallback((id: string) => {
      setAttachments((prev) => prev.filter((a) => a.id !== id));
    }, []);

    // File input change handler
    const handleFileInputChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (files?.length) {
          handleFiles(Array.from(files));
        }
        // Reset input so same file can be selected again
        e.target.value = "";
      },
      [handleFiles]
    );

    // Open file dialog
    const openFilePicker = useCallback(() => {
      fileInputRef.current?.click();
    }, []);

    // Drag and drop handlers
    const handleDragEnter = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCountRef.current++;
      if (e.dataTransfer.types.includes("Files")) {
        setIsDragging(true);
      }
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCountRef.current--;
      if (dragCountRef.current === 0) {
        setIsDragging(false);
      }
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    }, []);

    const handleDrop = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        dragCountRef.current = 0;

        if (disabled) {return;}

        const files = getFilesFromDrag(e.nativeEvent);
        if (files.length) {
          handleFiles(files);
        }
      },
      [disabled, handleFiles]
    );

    // Paste handler - should be attached to parent input
    const handlePaste = useCallback(
      (e: ClipboardEvent) => {
        if (disabled) {return;}

        const files = getFilesFromClipboard(e);
        if (files.length) {
          e.preventDefault();
          handleFiles(files);
        }
      },
      [disabled, handleFiles]
    );

    // Attach paste listener to document
    useEffect(() => {
      document.addEventListener("paste", handlePaste);
      return () => document.removeEventListener("paste", handlePaste);
    }, [handlePaste]);

    // Local file browser functions
    const fetchLocalFiles = useCallback(async (path?: string) => {
      setLoadingLocal(true);
      try {
        const res = await fetch(`/api/files?action=browse${path ? `&path=${encodeURIComponent(path)}` : ""}`);
        const data = await res.json();
        if (data.files) {
          setLocalFiles(data.files);
          if (data.currentPath) {
            setLocalPath(data.currentPath.split("/").filter(Boolean));
          }
        }
      } catch (error) {
        console.error("Failed to fetch local files:", error);
      } finally {
        setLoadingLocal(false);
      }
    }, []);

    const openLocalBrowser = useCallback(() => {
      if (onOpenFileBrowser) {
        onOpenFileBrowser();
      } else {
        setShowLocalBrowser(true);
        fetchLocalFiles();
      }
    }, [onOpenFileBrowser, fetchLocalFiles]);

    const selectLocalFile = useCallback(
      async (file: LocalFile) => {
        if (file.isDirectory) {
          fetchLocalFiles(file.path);
        } else {
          // Fetch the file content
          try {
            const res = await fetch(`/api/files?action=read&path=${encodeURIComponent(file.path)}`);
            const data = await res.json();
            if (data.content) {
              // Create a File object from the content
              const blob = new Blob([data.content], { type: data.type || "text/plain" });
              const fileObj = new File([blob], file.name, { type: data.type || "text/plain" });
              handleFiles([fileObj]);
              setShowLocalBrowser(false);
            }
          } catch (error) {
            console.error("Failed to read file:", error);
          }
        }
      },
      [fetchLocalFiles, handleFiles]
    );

    const navigateToPathIndex = useCallback(
      (index: number) => {
        const newPath = localPath.slice(0, index + 1).join("/");
        fetchLocalFiles(newPath || undefined);
      },
      [localPath, fetchLocalFiles]
    );

    // ========== Render ==========

    return (
      <div className={`relative ${className}`}>
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={buildAcceptString()}
          onChange={handleFileInputChange}
          className="hidden"
          disabled={disabled}
        />

        {/* Attachment preview row */}
        {attachments.length > 0 && (
          <div className="flex gap-2 mb-3 overflow-x-auto pb-2 scrollbar-thin">
            {attachments.map((attachment) => (
              <AttachmentPreview
                key={attachment.id}
                attachment={attachment}
                onRemove={() => removeAttachment(attachment.id)}
              />
            ))}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-1">
          {/* File picker button */}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={openFilePicker}
            disabled={disabled || attachments.length >= maxAttachments}
            title="Attach file"
            className="text-muted-foreground hover:text-foreground"
          >
            <Paperclip className="w-4 h-4" />
          </Button>

          {/* Local file browser button */}
          {showFileBrowser && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={openLocalBrowser}
              disabled={disabled}
              title="Browse workspace files (@file)"
              className="text-muted-foreground hover:text-foreground"
            >
              <AtSign className="w-4 h-4" />
            </Button>
          )}
        </div>

        {/* Drag overlay */}
        <div
          ref={dropZoneRef}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          className={`
            fixed inset-0 z-50 flex items-center justify-center
            bg-background/80 backdrop-blur-sm border-2 border-dashed border-primary
            transition-opacity duration-200
            ${isDragging ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}
          `}
        >
          <div className="flex flex-col items-center gap-3 text-center p-8">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Upload className="w-8 h-8 text-primary" />
            </div>
            <div>
              <h3 className="text-lg font-semibold">Drop files here</h3>
              <p className="text-sm text-muted-foreground">
                Images, PDFs, code files, and text files
              </p>
            </div>
          </div>
        </div>

        {/* Local file browser modal */}
        {showLocalBrowser && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="bg-card border rounded-lg shadow-lg w-full max-w-lg max-h-[70vh] flex flex-col">
              {/* Header */}
              <div className="flex items-center justify-between p-4 border-b">
                <div className="flex items-center gap-2">
                  <FolderOpen className="w-5 h-5 text-primary" />
                  <h3 className="font-semibold">Browse Workspace Files</h3>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setShowLocalBrowser(false)}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>

              {/* Breadcrumb */}
              <div className="flex items-center gap-1 px-4 py-2 border-b bg-muted/30 text-sm overflow-x-auto">
                <button
                  onClick={() => fetchLocalFiles()}
                  className="text-muted-foreground hover:text-foreground"
                >
                  workspace
                </button>
                {localPath.map((segment, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <ChevronRight className="w-3 h-3 text-muted-foreground" />
                    <button
                      onClick={() => navigateToPathIndex(i)}
                      className={
                        i === localPath.length - 1
                          ? "text-foreground font-medium"
                          : "text-muted-foreground hover:text-foreground"
                      }
                    >
                      {segment}
                    </button>
                  </div>
                ))}
              </div>

              {/* File list */}
              <div className="flex-1 overflow-y-auto p-2">
                {loadingLocal ? (
                  <div className="flex items-center justify-center h-32">
                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                  </div>
                ) : localFiles.length === 0 ? (
                  <div className="flex items-center justify-center h-32 text-muted-foreground">
                    No files found
                  </div>
                ) : (
                  <div className="space-y-1">
                    {localFiles.map((file) => (
                      <button
                        key={file.path}
                        onClick={() => selectLocalFile(file)}
                        className="w-full flex items-center gap-3 p-2 rounded-md hover:bg-muted text-left transition-colors"
                      >
                        {file.isDirectory ? (
                          <FolderOpen className="w-4 h-4 text-amber-500" />
                        ) : (
                          <FileIcon
                            category={file.name.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? "image" : "code"}
                            filename={file.name}
                            className="w-4 h-4 text-muted-foreground"
                          />
                        )}
                        <span className="flex-1 truncate text-sm">{file.name}</span>
                        {!file.isDirectory && file.size !== undefined && (
                          <span className="text-xs text-muted-foreground">
                            {formatFileSize(file.size)}
                          </span>
                        )}
                        {file.isDirectory && (
                          <ChevronRight className="w-4 h-4 text-muted-foreground" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
);

// ========== Attachment Preview Component ==========

interface AttachmentPreviewProps {
  attachment: FileAttachment;
  onRemove: () => void;
}

function AttachmentPreview({ attachment, onRemove }: AttachmentPreviewProps) {
  const isImage = attachment.category === "image";
  const isPending = attachment.status === "pending" || attachment.status === "processing";
  const hasError = attachment.status === "error";

  return (
    <div
      className={`
        relative group flex-shrink-0
        ${isImage ? "w-20 h-20" : "w-auto max-w-48"}
        rounded-lg overflow-hidden border
        ${hasError ? "border-destructive/50 bg-destructive/10" : "border-border bg-card"}
        transition-all hover:border-primary/50
      `}
    >
      {/* Image preview */}
      {isImage && attachment.preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={attachment.preview}
          alt={attachment.name}
          className="w-full h-full object-cover"
        />
      ) : (
        /* File info */
        <div className="flex items-center gap-2 p-2 h-full">
          <div
            className={`
              w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0
              ${hasError ? "bg-destructive/20 text-destructive" : "bg-muted text-muted-foreground"}
            `}
          >
            {hasError ? (
              <AlertCircle className="w-5 h-5" />
            ) : (
              <FileIcon
                category={attachment.category}
                filename={attachment.name}
                className="w-5 h-5"
              />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium truncate">{attachment.name}</p>
            {hasError ? (
              <p className="text-[10px] text-destructive truncate">{attachment.error}</p>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                {attachment.language || formatFileSize(attachment.size)}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Loading overlay */}
      {isPending && (
        <div className="absolute inset-0 bg-background/60 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
        </div>
      )}

      {/* Remove button */}
      <button
        onClick={onRemove}
        className={`
          absolute top-1 right-1 p-1 rounded-full
          bg-background/80 hover:bg-background
          text-muted-foreground hover:text-foreground
          opacity-0 group-hover:opacity-100 transition-opacity
          shadow-sm
        `}
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

// ========== Export helpers ==========

export type { FileAttachment };
export {
  formatFileSize,
  getLanguageFromFile,
  processFile,
  validateFile,
} from "@/lib/file-utils";
