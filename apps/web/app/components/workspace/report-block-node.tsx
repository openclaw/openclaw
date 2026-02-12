"use client";

import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import { useState, useCallback } from "react";
import type { ReportConfig } from "../../components/charts/types";

// Lazy-load ReportCard to keep bundle light
import dynamic from "next/dynamic";
const ReportCard = dynamic(
  () =>
    import("../../components/charts/report-card").then((m) => ({
      default: m.ReportCard,
    })),
  {
    ssr: false,
    loading: () => (
      <div
        className="h-48 rounded-xl animate-pulse"
        style={{ background: "var(--color-surface)" }}
      />
    ),
  },
);

// --- React NodeView Component ---

function ReportBlockView({
  node,
  updateAttributes,
  deleteNode,
  selected,
}: {
  node: { attrs: { config: string } };
  updateAttributes: (attrs: Record<string, unknown>) => void;
  deleteNode: () => void;
  selected: boolean;
}) {
  const [showSource, setShowSource] = useState(false);
  const [editValue, setEditValue] = useState(node.attrs.config);

  let parsedConfig: ReportConfig | null = null;
  let parseError: string | null = null;

  try {
    const parsed = JSON.parse(node.attrs.config);
    if (parsed?.panels && Array.isArray(parsed.panels)) {
      parsedConfig = parsed as ReportConfig;
    } else {
      parseError = "Invalid report config: missing panels array";
    }
  } catch {
    parseError = "Invalid JSON in report block";
  }

  const handleSaveSource = useCallback(() => {
    try {
      JSON.parse(editValue); // validate
      updateAttributes({ config: editValue });
      setShowSource(false);
    } catch {
      // Don't close if invalid JSON
    }
  }, [editValue, updateAttributes]);

  return (
    <NodeViewWrapper
      className="report-block-wrapper"
      data-selected={selected || undefined}
    >
      {/* Overlay toolbar */}
      <div className="report-block-toolbar">
        <button
          type="button"
          onClick={() => {
            if (showSource) {
              handleSaveSource();
            } else {
              setEditValue(node.attrs.config);
              setShowSource(true);
            }
          }}
          className="report-block-btn"
          title={showSource ? "Apply & show chart" : "Edit JSON source"}
        >
          {showSource ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
          )}
          <span>{showSource ? "Apply" : "Edit JSON"}</span>
        </button>
        <button
          type="button"
          onClick={deleteNode}
          className="report-block-btn report-block-btn-danger"
          title="Remove report block"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          </svg>
        </button>
      </div>

      {showSource ? (
        /* JSON source editor */
        <div className="report-block-source">
          <div className="report-block-source-label">report-json</div>
          <textarea
            className="report-block-textarea"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            spellCheck={false}
            rows={Math.min(20, editValue.split("\n").length + 2)}
          />
        </div>
      ) : parseError ? (
        /* Error state */
        <div className="report-block-error">
          <span>{parseError}</span>
          <button
            type="button"
            onClick={() => {
              setEditValue(node.attrs.config);
              setShowSource(true);
            }}
            className="report-block-btn"
          >
            Fix JSON
          </button>
        </div>
      ) : (
        /* Rendered chart */
        <ReportCard config={parsedConfig!} />
      )}
    </NodeViewWrapper>
  );
}

// --- Tiptap Node Extension ---

export const ReportBlockNode = Node.create({
  name: "reportBlock",
  group: "block",
  atom: true, // not editable inline -- managed by NodeView

  addAttributes() {
    return {
      config: {
        default: "{}",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-config") || "{}",
        renderHTML: (attributes: Record<string, string>) => ({
          "data-config": attributes.config,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="report-block"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": "report-block" }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ReportBlockView);
  },
});

/**
 * Pre-process markdown before Tiptap parses it:
 * Convert ```report-json ... ``` fenced blocks into HTML that Tiptap can parse
 * as ReportBlock nodes.
 */
export function preprocessReportBlocks(markdown: string): string {
  return markdown.replace(
    /```report-json\s*\n([\s\S]*?)```/g,
    (_match, json: string) => {
      const escaped = json
        .trim()
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<div data-type="report-block" data-config="${escaped}"></div>`;
    },
  );
}

/**
 * Post-process HTML before serializing to markdown:
 * Convert ReportBlock HTML back to ```report-json``` fenced blocks.
 */
export function postprocessReportBlocks(markdown: string): string {
  return markdown.replace(
    /<div data-type="report-block" data-config="([^"]*)">\s*<\/div>/g,
    (_match, escaped: string) => {
      const json = escaped
        .replace(/&gt;/g, ">")
        .replace(/&lt;/g, "<")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");
      return "```report-json\n" + json + "\n```";
    },
  );
}
