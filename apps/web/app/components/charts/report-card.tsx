"use client";

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChartPanel } from "./chart-panel";
import type { ReportConfig, PanelConfig } from "./types";

type ReportCardProps = {
  config: ReportConfig;
};

// --- Icons ---

function ChartBarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" x2="12" y1="20" y2="10" />
      <line x1="18" x2="18" y1="20" y2="4" />
      <line x1="6" x2="6" y1="20" y2="14" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" x2="14" y1="3" y2="10" />
      <line x1="3" x2="10" y1="21" y2="14" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" x2="21" y1="10" y2="3" />
      <line x1="3" x2="10" y1="21" y2="14" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" x2="12" y1="17" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  );
}

// --- Panel data state ---

type PanelData = {
  rows: Record<string, unknown>[];
  loading: boolean;
  error?: string;
};

// --- Grid size helpers ---

function panelColSpan(size?: string): string {
  switch (size) {
    case "full":
      return "col-span-2 sm:col-span-4 lg:col-span-6";
    case "third":
      return "col-span-1 sm:col-span-2 lg:col-span-2";
    case "half":
    default:
      return "col-span-2 sm:col-span-2 lg:col-span-3";
  }
}

// --- Main ReportCard ---

export function ReportCard({ config }: ReportCardProps) {
  const [panelData, setPanelData] = useState<Record<string, PanelData>>({});
  const [pinning, setPinning] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // In compact mode show at most 2 panels; expanded shows all
  const visiblePanels = expanded ? config.panels : config.panels.slice(0, 2);
  const hasMore = config.panels.length > 2;

  // Execute panel SQL queries
  const executePanels = useCallback(async (panels: PanelConfig[]) => {
    const initial: Record<string, PanelData> = {};
    for (const panel of panels) {
      initial[panel.id] = { rows: [], loading: true };
    }
    setPanelData((prev) => ({ ...prev, ...initial }));

    await Promise.all(
      panels.map(async (panel) => {
        try {
          const res = await fetch("/api/workspace/reports/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sql: panel.sql }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            setPanelData((prev) => ({
              ...prev,
              [panel.id]: { rows: [], loading: false, error: data.error || `HTTP ${res.status}` },
            }));
            return;
          }
          const data = await res.json();
          setPanelData((prev) => ({
            ...prev,
            [panel.id]: { rows: data.rows ?? [], loading: false },
          }));
        } catch (err) {
          setPanelData((prev) => ({
            ...prev,
            [panel.id]: { rows: [], loading: false, error: err instanceof Error ? err.message : "Failed" },
          }));
        }
      }),
    );
  }, []);

  // Load initial compact panels
  useEffect(() => {
    void executePanels(config.panels.slice(0, 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When expanding, fetch any panels not yet loaded
  const handleToggleExpand = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      if (next && hasMore) {
        const unloaded = config.panels.filter((p) => !panelData[p.id]);
        if (unloaded.length > 0) {
          void executePanels(unloaded);
        }
      }
      return next;
    });
  }, [hasMore, config.panels, panelData, executePanels]);

  // Refresh all visible panels
  const handleRefresh = useCallback(() => {
    void executePanels(expanded ? config.panels : config.panels.slice(0, 2));
  }, [expanded, config.panels, executePanels]);

  // Pin report to workspace /reports directory
  const handlePin = async () => {
    setPinning(true);
    try {
      const slug = config.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
      const filename = `${slug}.report.json`;

      await fetch("/api/workspace/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: `reports/${filename}`,
          content: JSON.stringify(config, null, 2),
        }),
      });
      setPinned(true);
    } catch {
      // silently fail
    } finally {
      setPinning(false);
    }
  };

  return (
    <div
      className="rounded-xl overflow-hidden my-2 transition-all duration-200"
      style={{
        background: "var(--color-bg)",
        border: "1px solid var(--color-border)",
        maxWidth: "100%",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 border-b"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span style={{ color: "#22c55e" }}>
            <ChartBarIcon />
          </span>
          <span
            className="text-sm font-medium truncate"
            style={{ color: "var(--color-text)" }}
          >
            {config.title}
          </span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0"
            style={{
              background: "rgba(34, 197, 94, 0.1)",
              color: "#22c55e",
            }}
          >
            {config.panels.length} chart{config.panels.length !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {expanded && (
            <button
              type="button"
              onClick={handleRefresh}
              className="p-1 rounded-md transition-colors cursor-pointer"
              style={{ color: "var(--color-text-muted)" }}
              title="Refresh data"
            >
              <RefreshIcon />
            </button>
          )}
          {!pinned ? (
            <button
              type="button"
              onClick={handlePin}
              disabled={pinning}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] transition-colors cursor-pointer disabled:opacity-40"
              style={{
                color: "var(--color-text-muted)",
                background: "var(--color-surface)",
                border: "1px solid var(--color-border)",
              }}
              title="Save to workspace /reports"
            >
              <PinIcon />
              {pinning ? "Saving..." : "Pin"}
            </button>
          ) : (
            <span
              className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-md"
              style={{ color: "#22c55e", background: "rgba(34, 197, 94, 0.1)" }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Pinned
            </span>
          )}
          <button
            type="button"
            onClick={handleToggleExpand}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] transition-colors cursor-pointer"
            style={{
              color: expanded ? "var(--color-text)" : "var(--color-accent)",
              background: expanded ? "var(--color-surface-hover)" : "var(--color-accent-light)",
            }}
            title={expanded ? "Collapse report" : "Expand full report"}
          >
            {expanded ? <CollapseIcon /> : <ExpandIcon />}
            {expanded ? "Collapse" : "Open"}
          </button>
        </div>
      </div>

      {/* Description */}
      {config.description && (
        <div className="px-3 py-1.5">
          <p className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
            {config.description}
          </p>
        </div>
      )}

      <AnimatePresence mode="wait" initial={false}>
        {expanded ? (
          /* ── Expanded: full grid with all panels ── */
          <motion.div
            key="expanded"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 p-3">
              {config.panels.map((panel) => (
                <ExpandedPanelCard
                  key={panel.id}
                  panel={panel}
                  data={panelData[panel.id]}
                />
              ))}
            </div>
          </motion.div>
        ) : (
          /* ── Compact: max 2 panels ── */
          <motion.div
            key="compact"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <div className={`grid gap-2 p-2 ${visiblePanels.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
              {visiblePanels.map((panel) => (
                <CompactPanelCard
                  key={panel.id}
                  panel={panel}
                  data={panelData[panel.id]}
                />
              ))}
            </div>

            {/* More panels indicator */}
            {hasMore && (
              <button
                type="button"
                onClick={handleToggleExpand}
                className="w-full px-3 py-1.5 text-center border-t cursor-pointer transition-colors hover:opacity-80"
                style={{ borderColor: "var(--color-border)" }}
              >
                <span className="text-[10px]" style={{ color: "var(--color-accent)" }}>
                  +{config.panels.length - 2} more chart{config.panels.length - 2 !== 1 ? "s" : ""} — click to expand
                </span>
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// --- Compact panel card for inline rendering ---

function CompactPanelCard({
  panel,
  data,
}: {
  panel: PanelConfig;
  data?: PanelData;
}) {
  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="px-2.5 py-1.5">
        <h4
          className="text-[11px] font-medium truncate"
          style={{ color: "var(--color-text)" }}
        >
          {panel.title}
        </h4>
      </div>
      <div className="px-1 pb-1">
        {data?.loading ? (
          <div className="flex items-center justify-center" style={{ height: 200 }}>
            <div
              className="w-4 h-4 border-2 rounded-full animate-spin"
              style={{
                borderColor: "var(--color-border)",
                borderTopColor: "var(--color-accent)",
              }}
            />
          </div>
        ) : data?.error ? (
          <div className="flex items-center justify-center" style={{ height: 200 }}>
            <p className="text-[10px]" style={{ color: "#f87171" }}>
              {data.error}
            </p>
          </div>
        ) : (
          <ChartPanel config={panel} data={data?.rows ?? []} compact />
        )}
      </div>
    </div>
  );
}

// --- Expanded panel card for full report view ---

function ExpandedPanelCard({
  panel,
  data,
}: {
  panel: PanelConfig;
  data?: PanelData;
}) {
  const colSpan = panelColSpan(panel.size);

  return (
    <div
      className={`${colSpan} rounded-xl overflow-hidden`}
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="px-3 py-2 flex items-center justify-between">
        <h4
          className="text-xs font-medium"
          style={{ color: "var(--color-text)" }}
        >
          {panel.title}
        </h4>
        {data && !data.loading && !data.error && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ color: "var(--color-text-muted)" }}
          >
            {data.rows.length} rows
          </span>
        )}
      </div>
      <div className="px-1.5 pb-2">
        {data?.loading ? (
          <div className="flex items-center justify-center" style={{ height: 280 }}>
            <div
              className="w-4 h-4 border-2 rounded-full animate-spin"
              style={{
                borderColor: "var(--color-border)",
                borderTopColor: "var(--color-accent)",
              }}
            />
          </div>
        ) : data?.error ? (
          <div className="flex flex-col items-center justify-center gap-1.5" style={{ height: 280 }}>
            <p className="text-[10px]" style={{ color: "#f87171" }}>
              Query error
            </p>
            <p
              className="text-[10px] px-2 py-1 rounded max-w-xs text-center"
              style={{ background: "rgba(248, 113, 113, 0.1)", color: "#f87171" }}
            >
              {data.error}
            </p>
          </div>
        ) : (
          <ChartPanel config={panel} data={data?.rows ?? []} />
        )}
      </div>
    </div>
  );
}
