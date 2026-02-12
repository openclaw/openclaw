"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";

import { ReportBlockNode, preprocessReportBlocks, postprocessReportBlocks } from "./report-block-node";
import { createSlashCommand, createFileMention, type TreeNode } from "./slash-command";

// --- Types ---

export type MarkdownEditorProps = {
  /** The markdown body (frontmatter already stripped by parent). */
  content: string;
  /** Original raw file content including frontmatter, used to preserve it on save. */
  rawContent?: string;
  filePath: string;
  tree: TreeNode[];
  onSave?: () => void;
  onNavigate?: (path: string) => void;
  /** Switch to read-only mode (renders a "Read" button in the top bar). */
  onSwitchToRead?: () => void;
};

// --- Main component ---

/** Extract YAML frontmatter (if any) from raw file content. */
function extractFrontmatter(raw: string): string {
  const match = raw.match(/^(---\s*\n[\s\S]*?\n---\s*\n)/);
  return match ? match[1] : "";
}

export function MarkdownEditor({
  content,
  rawContent,
  filePath,
  tree,
  onSave,
  onNavigate,
  onSwitchToRead,
}: MarkdownEditorProps) {
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [isDirty, setIsDirty] = useState(false);
  // Tracks the `content` prop so we can detect external updates (parent re-fetch).
  // Only updated when the prop itself changes -- never on save.
  const lastPropContentRef = useRef(content);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Preserve frontmatter so save can prepend it back
  const frontmatterRef = useRef(extractFrontmatter(rawContent ?? ""));

  // "/" for block commands, "@" for file mentions
  const slashCommand = useMemo(() => createSlashCommand(), []);
  const fileMention = useMemo(() => createFileMention(tree), [tree]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: {
          HTMLAttributes: { class: "code-block" },
        },
      }),
      Markdown.configure({
        markedOptions: { gfm: true },
      }),
      Image.configure({
        inline: false,
        allowBase64: true,
        HTMLAttributes: { class: "editor-image" },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: "editor-link" },
      }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        placeholder: "Start writing, or type / for commands...",
      }),
      ReportBlockNode,
      slashCommand,
      fileMention,
    ],
    // Parse initial content as markdown (not HTML -- the default)
    content: preprocessReportBlocks(content),
    contentType: "markdown",
    immediatelyRender: false,
    onUpdate: () => {
      setIsDirty(true);
      setSaveStatus("idle");
    },
  });

  // --- Image upload helper ---
  const uploadImage = useCallback(
    async (file: File): Promise<string | null> => {
      const form = new FormData();
      form.append("file", file);
      try {
        const res = await fetch("/api/workspace/upload", {
          method: "POST",
          body: form,
        });
        if (!res.ok) {return null;}
        const data = await res.json();
        // Return a URL the browser can fetch to display the image
        return `/api/workspace/assets/${(data.path as string).replace(/^assets\//, "")}`;
      } catch {
        return null;
      }
    },
    [],
  );

  /** Upload one or more image Files and insert them at the current cursor. */
  const insertUploadedImages = useCallback(
    async (files: File[]) => {
      if (!editor) {return;}
      for (const file of files) {
        const url = await uploadImage(file);
        if (url) {
          editor.chain().focus().setImage({ src: url, alt: file.name }).run();
        }
      }
    },
    [editor, uploadImage],
  );

  // --- Drop & paste handlers for images ---
  useEffect(() => {
    if (!editor) {return;}

    const editorElement = editor.view.dom;

    // Prevent the browser default (open file in tab) and upload instead
    const handleDrop = (event: DragEvent) => {
      if (!event.dataTransfer?.files?.length) {return;}

      const imageFiles = Array.from(event.dataTransfer.files).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (imageFiles.length === 0) {return;}

      event.preventDefault();
      event.stopPropagation();
      insertUploadedImages(imageFiles);
    };

    // Also prevent dragover so the browser doesn't hijack the drop
    const handleDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types?.includes("Files")) {
        event.preventDefault();
      }
    };

    const handlePaste = (event: ClipboardEvent) => {
      if (!event.clipboardData) {return;}

      // 1. Handle pasted image files (e.g. screenshots)
      const imageFiles = Array.from(event.clipboardData.files).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (imageFiles.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        insertUploadedImages(imageFiles);
        return;
      }

      // 2. Handle pasted text that looks like a local image path or file:// URL
      const text = event.clipboardData.getData("text/plain");
      if (!text) {return;}

      const isLocalPath =
        text.startsWith("file://") ||
        /^(\/|~\/|[A-Z]:\\).*\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(text.trim());

      if (isLocalPath) {
        event.preventDefault();
        event.stopPropagation();
        // Insert as an image node directly -- the browser can't fetch file:// but
        // the user likely has the file accessible on their machine. We insert the
        // cleaned path; the asset serving route won't help here but at least the
        // markdown ![](path) will be correct.
        const cleanPath = text.trim().replace(/^file:\/\//, "");
        editor?.chain().focus().setImage({ src: cleanPath }).run();
      }
    };

    editorElement.addEventListener("drop", handleDrop);
    editorElement.addEventListener("dragover", handleDragOver);
    editorElement.addEventListener("paste", handlePaste);
    return () => {
      editorElement.removeEventListener("drop", handleDrop);
      editorElement.removeEventListener("dragover", handleDragOver);
      editorElement.removeEventListener("paste", handlePaste);
    };
  }, [editor, insertUploadedImages]);

  // Handle link clicks for workspace navigation
  useEffect(() => {
    if (!editor || !onNavigate) {return;}

    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const link = target.closest("a");
      if (!link) {return;}

      const href = link.getAttribute("href");
      if (!href) {return;}

      // Workspace-internal link (relative path, no protocol)
      if (!href.startsWith("http://") && !href.startsWith("https://") && !href.startsWith("mailto:")) {
        event.preventDefault();
        event.stopPropagation();
        onNavigate(href);
      }
    };

    const editorElement = editor.view.dom;
    editorElement.addEventListener("click", handleClick);
    return () => editorElement.removeEventListener("click", handleClick);
  }, [editor, onNavigate]);

  // Save handler
  const handleSave = useCallback(async () => {
    if (!editor || saving) {return;}

    setSaving(true);
    setSaveStatus("idle");

    try {
      // Serialize editor content back to markdown
      // The Markdown extension adds getMarkdown() to the editor instance
      const editorAny = editor as unknown as { getMarkdown?: () => string };
      let markdown: string;

      if (typeof editorAny.getMarkdown === "function") {
        markdown = editorAny.getMarkdown();
      } else {
        // Fallback: use HTML output
        markdown = editor.getHTML();
      }

      // Convert report block HTML back to ```report-json``` fenced blocks
      const bodyContent = postprocessReportBlocks(markdown);
      // Prepend preserved frontmatter so it isn't lost on save
      const finalContent = frontmatterRef.current + bodyContent;

      const res = await fetch("/api/workspace/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, content: finalContent }),
      });

      if (res.ok) {
        setSaveStatus("saved");
        setIsDirty(false);
        // Sync the prop tracker to the body we just saved so the external-update
        // effect doesn't see a mismatch and reset the editor.
        lastPropContentRef.current = content;
        onSave?.();

        // Clear "saved" indicator after 2s
        if (saveTimerRef.current) {clearTimeout(saveTimerRef.current);}
        saveTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
      } else {
        setSaveStatus("error");
      }
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  }, [editor, filePath, saving, onSave]);

  // Keyboard shortcut: Cmd/Ctrl+S
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleSave]);

  // Update content when file changes externally (parent re-fetched the file)
  useEffect(() => {
    if (!editor || isDirty) {return;}
    if (content !== lastPropContentRef.current) {
      lastPropContentRef.current = content;
      // Also update frontmatter in case the raw content changed
      frontmatterRef.current = extractFrontmatter(rawContent ?? "");
      const processed = preprocessReportBlocks(content);
      editor.commands.setContent(processed, { contentType: "markdown" });
      setIsDirty(false);
    }
  }, [content, rawContent, editor, isDirty]);

  if (!editor) {
    return (
      <div className="animate-pulse space-y-3 py-4 px-6">
        <div className="h-4 rounded" style={{ background: "var(--color-surface)", width: "80%" }} />
        <div className="h-4 rounded" style={{ background: "var(--color-surface)", width: "60%" }} />
        <div className="h-4 rounded" style={{ background: "var(--color-surface)", width: "70%" }} />
      </div>
    );
  }

  return (
    <div className="markdown-editor-container">
      {/* Sticky top bar: save status + save button + read toggle */}
      <div className="editor-top-bar">
        <div className="editor-top-bar-left">
          {isDirty && (
            <span className="editor-save-indicator editor-save-unsaved">
              Unsaved changes
            </span>
          )}
          {saveStatus === "saved" && !isDirty && (
            <span className="editor-save-indicator editor-save-saved">
              Saved
            </span>
          )}
          {saveStatus === "error" && (
            <span className="editor-save-indicator editor-save-error">
              Save failed
            </span>
          )}
        </div>
        <div className="editor-top-bar-right">
          <span className="editor-save-hint">
            {typeof navigator !== "undefined" && navigator.platform?.includes("Mac") ? "\u2318" : "Ctrl"}+S
          </span>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !isDirty}
            className="editor-save-button"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          {onSwitchToRead && (
            <button
              type="button"
              onClick={onSwitchToRead}
              className="editor-mode-toggle"
              title="Switch to read mode"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <span>Read</span>
            </button>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <EditorToolbar editor={editor} onUploadImages={insertUploadedImages} />

      {/* Bubble menu for text selection */}
      <BubbleMenu editor={editor} tippyOptions={{ duration: 100 }}>
        <div className="bubble-menu">
          <BubbleButton
            active={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
            title="Bold"
          >
            <strong>B</strong>
          </BubbleButton>
          <BubbleButton
            active={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            title="Italic"
          >
            <em>I</em>
          </BubbleButton>
          <BubbleButton
            active={editor.isActive("strike")}
            onClick={() => editor.chain().focus().toggleStrike().run()}
            title="Strikethrough"
          >
            <s>S</s>
          </BubbleButton>
          <BubbleButton
            active={editor.isActive("code")}
            onClick={() => editor.chain().focus().toggleCode().run()}
            title="Inline code"
          >
            {"<>"}
          </BubbleButton>
          <BubbleButton
            active={editor.isActive("link")}
            onClick={() => {
              if (editor.isActive("link")) {
                editor.chain().focus().unsetLink().run();
              } else {
                const url = window.prompt("URL:");
                if (url) {
                  editor.chain().focus().setLink({ href: url }).run();
                }
              }
            }}
            title="Link"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </BubbleButton>
        </div>
      </BubbleMenu>

      {/* Editor content */}
      <div className="editor-content-area workspace-prose">
        <EditorContent editor={editor} />
      </div>

    </div>
  );
}

// --- Toolbar ---

function EditorToolbar({
  editor,
  onUploadImages,
}: {
  editor: ReturnType<typeof useEditor>;
  onUploadImages?: (files: File[]) => void;
}) {
  const imageInputRef = useRef<HTMLInputElement>(null);

  if (!editor) {return null;}

  return (
    <div className="editor-toolbar">
      {/* Headings */}
      <ToolbarGroup>
        <ToolbarButton
          active={editor.isActive("heading", { level: 1 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          title="Heading 1"
        >
          H1
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("heading", { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          title="Heading 2"
        >
          H2
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("heading", { level: 3 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          title="Heading 3"
        >
          H3
        </ToolbarButton>
      </ToolbarGroup>

      <ToolbarDivider />

      {/* Inline formatting */}
      <ToolbarGroup>
        <ToolbarButton
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="Bold"
        >
          <strong>B</strong>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="Italic"
        >
          <em>I</em>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("strike")}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          title="Strikethrough"
        >
          <s>S</s>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("code")}
          onClick={() => editor.chain().focus().toggleCode().run()}
          title="Inline code"
        >
          {"<>"}
        </ToolbarButton>
      </ToolbarGroup>

      <ToolbarDivider />

      {/* Block elements */}
      <ToolbarGroup>
        <ToolbarButton
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title="Bullet list"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="8" x2="21" y1="6" y2="6" /><line x1="8" x2="21" y1="12" y2="12" /><line x1="8" x2="21" y1="18" y2="18" />
            <line x1="3" x2="3.01" y1="6" y2="6" /><line x1="3" x2="3.01" y1="12" y2="12" /><line x1="3" x2="3.01" y1="18" y2="18" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title="Ordered list"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="10" x2="21" y1="6" y2="6" /><line x1="10" x2="21" y1="12" y2="12" /><line x1="10" x2="21" y1="18" y2="18" />
            <path d="M4 6h1v4" /><path d="M4 10h2" /><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("taskList")}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
          title="Task list"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="5" width="6" height="6" rx="1" /><path d="m3 17 2 2 4-4" /><line x1="13" x2="21" y1="6" y2="6" /><line x1="13" x2="21" y1="18" y2="18" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("blockquote")}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          title="Blockquote"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z" />
            <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3z" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("codeBlock")}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          title="Code block"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
          </svg>
        </ToolbarButton>
      </ToolbarGroup>

      <ToolbarDivider />

      {/* Insert items */}
      <ToolbarGroup>
        <ToolbarButton
          active={false}
          onClick={() => {
            const url = window.prompt("Link URL:");
            if (url) {
              editor.chain().focus().setLink({ href: url }).run();
            }
          }}
          title="Insert link"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          active={false}
          onClick={() => {
            // Open file picker for local images; shift-click for URL input
            if (onUploadImages) {
              imageInputRef.current?.click();
            } else {
              const url = window.prompt("Image URL:");
              if (url) {
                editor.chain().focus().setImage({ src: url }).run();
              }
            }
          }}
          title="Insert image (click to upload, or drag & drop)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
          </svg>
        </ToolbarButton>
        {/* Hidden file input for image upload */}
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0 && onUploadImages) {
              onUploadImages(files);
            }
            // Reset so the same file can be picked again
            e.target.value = "";
          }}
        />
        <ToolbarButton
          active={false}
          onClick={() => {
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
          }}
          title="Insert table"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v18" /><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          active={false}
          onClick={() => {
            editor.chain().focus().setHorizontalRule().run();
          }}
          title="Horizontal rule"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="2" x2="22" y1="12" y2="12" />
          </svg>
        </ToolbarButton>
      </ToolbarGroup>
    </div>
  );
}

// --- Toolbar primitives ---

function ToolbarGroup({ children }: { children: React.ReactNode }) {
  return <div className="editor-toolbar-group">{children}</div>;
}

function ToolbarDivider() {
  return <div className="editor-toolbar-divider" />;
}

function ToolbarButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`editor-toolbar-btn ${active ? "editor-toolbar-btn-active" : ""}`}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

// --- Bubble menu button ---

function BubbleButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`bubble-menu-btn ${active ? "bubble-menu-btn-active" : ""}`}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}
