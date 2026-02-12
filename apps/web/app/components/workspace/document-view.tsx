"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { splitReportBlocks, hasReportBlocks } from "@/lib/report-blocks";
import type { TreeNode } from "./slash-command";

// Load markdown renderer client-only to avoid SSR issues with ESM-only packages
const MarkdownContent = dynamic(
  () =>
    import("./markdown-content").then((mod) => mod.MarkdownContent),
  {
    ssr: false,
    loading: () => (
      <div className="animate-pulse space-y-3 py-4">
        <div className="h-4 rounded" style={{ background: "var(--color-surface)", width: "80%" }} />
        <div className="h-4 rounded" style={{ background: "var(--color-surface)", width: "60%" }} />
        <div className="h-4 rounded" style={{ background: "var(--color-surface)", width: "70%" }} />
      </div>
    ),
  },
);

// Lazy-load ReportCard (uses Recharts which is heavy)
const ReportCard = dynamic(
  () =>
    import("../charts/report-card").then((m) => ({ default: m.ReportCard })),
  {
    ssr: false,
    loading: () => (
      <div
        className="h-48 rounded-xl animate-pulse my-4"
        style={{ background: "var(--color-surface)" }}
      />
    ),
  },
);

// Lazy-load the Tiptap-based editor (heavy -- keep out of initial bundle)
const MarkdownEditor = dynamic(
  () => import("./markdown-editor").then((m) => ({ default: m.MarkdownEditor })),
  {
    ssr: false,
    loading: () => (
      <div className="animate-pulse space-y-3 py-4 px-6">
        <div className="h-4 rounded" style={{ background: "var(--color-surface)", width: "80%" }} />
        <div className="h-4 rounded" style={{ background: "var(--color-surface)", width: "60%" }} />
        <div className="h-4 rounded" style={{ background: "var(--color-surface)", width: "70%" }} />
      </div>
    ),
  },
);

type DocumentViewProps = {
  content: string;
  title?: string;
  filePath?: string;
  tree?: TreeNode[];
  onSave?: () => void;
  onNavigate?: (path: string) => void;
};

export function DocumentView({
  content,
  title,
  filePath,
  tree,
  onSave,
  onNavigate,
}: DocumentViewProps) {
  const [editMode, setEditMode] = useState(!!filePath);

  // Strip YAML frontmatter if present
  const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "");

  // Extract title from first H1 if no title provided
  const h1Match = body.match(/^#\s+(.+)/m);
  const displayTitle = title ?? h1Match?.[1];
  const markdownBody =
    displayTitle && h1Match ? body.replace(/^#\s+.+\n?/, "") : body;

  // If we have a filePath and editing is enabled, render the Tiptap editor
  if (editMode && filePath) {
    return (
      <div className="max-w-3xl mx-auto">
        <MarkdownEditor
          content={body}
          rawContent={content}
          filePath={filePath}
          tree={tree ?? []}
          onSave={onSave}
          onNavigate={onNavigate}
          onSwitchToRead={() => setEditMode(false)}
        />
      </div>
    );
  }

  // Check if the markdown contains embedded report-json blocks
  const hasReports = hasReportBlocks(markdownBody);

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      {/* Header row with title + edit button */}
      <div className="flex items-start justify-between gap-4">
        {displayTitle && (
          <h1
            className="text-3xl font-bold mb-6 flex-1"
            style={{ color: "var(--color-text)" }}
          >
            {displayTitle}
          </h1>
        )}
        {filePath && (
          <button
            type="button"
            onClick={() => setEditMode(true)}
            className="editor-mode-toggle flex-shrink-0 mt-1"
            title="Edit this document"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
              <path d="m15 5 4 4" />
            </svg>
            <span>Edit</span>
          </button>
        )}
      </div>

      {hasReports ? (
        <EmbeddedReportContent content={markdownBody} />
      ) : (
        <div className="workspace-prose">
          <MarkdownContent content={markdownBody} />
        </div>
      )}
    </div>
  );
}

/**
 * Renders markdown content that contains embedded report-json blocks.
 * Splits the content into alternating markdown and interactive chart sections.
 */
function EmbeddedReportContent({ content }: { content: string }) {
  const segments = splitReportBlocks(content);

  return (
    <div className="space-y-4">
      {segments.map((segment, index) => {
        if (segment.type === "report-artifact") {
          return (
            <div key={index} className="my-6">
              <ReportCard config={segment.config} />
            </div>
          );
        }
        // Text segment -- render as markdown
        return (
          <div key={index} className="workspace-prose">
            <MarkdownContent content={segment.text} />
          </div>
        );
      })}
    </div>
  );
}
