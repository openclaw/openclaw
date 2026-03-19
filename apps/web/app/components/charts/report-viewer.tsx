"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { ChartPanel } from "./chart-panel";
import { FilterBar } from "./filter-bar";
import type { ReportConfig, FilterState, PanelConfig, FilterConfig } from "./types";

type ReportViewerProps = {
  /** Report config object (inline or loaded) */
  config?: ReportConfig;
  /** Path to load report config from filesystem */
  reportPath?: string;
};

// --- Icons ---

function ChartBarIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" x2="12" y1="20" y2="10" />
      <line x1="18" x2="18" y1="20" y2="4" />
      <line x1="6" x2="6" y1="20" y2="14" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  );
}

// --- Helpers ---

type PanelData = {
  panelId: string;
  rows: Record<string, unknown>[];
  loading: boolean;
  error?: string;
};

/** Build filter entries for the API from active filter state + filter configs. */
function buildFilterEntries(
  filterState: FilterState,
  filterConfigs: FilterConfig[],
): Array<{ id: string; column: string; value: FilterState[string] }> {
  const entries: Array<{ id: string; column: string; value: FilterState[string] }> = [];
  for (const fc of filterConfigs) {
    const v = filterState[fc.id];
    if (!v) {continue;}
    // Only include if the filter has an active value
    const hasValue =
      (v.type === "dateRange" && (v.from || v.to)) ||
      (v.type === "select" && v.value) ||
      (v.type === "multiSelect" && v.values && v.values.length > 0) ||
      (v.type === "number" && (v.min !== undefined || v.max !== undefined));
    if (hasValue) {
      entries.push({ id: fc.id, column: fc.column, value: v });
    }
  }
  return entries;
}

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

// --- Main ReportViewer ---

export function ReportViewer({ config: propConfig, reportPath }: ReportViewerProps) {
  const [config, setConfig] = useState<ReportConfig | null>(propConfig ?? null);
  const [configLoading, setConfigLoading] = useState(!propConfig && !!reportPath);
  const [configError, setConfigError] = useState<string | null>(null);
  const [panelData, setPanelData] = useState<Record<string, PanelData>>({});
  const [filterState, setFilterState] = useState<FilterState>({});
  const [refreshKey, setRefreshKey] = useState(0);

  // Load report config from filesystem if path provided
  useEffect(() => {
    if (propConfig) {
      setConfig(propConfig);
      return;
    }
    if (!reportPath) {return;}

    let cancelled = false;
    setConfigLoading(true);
    setConfigError(null);

    fetch(`/api/workspace/file?path=${encodeURIComponent(reportPath)}`)
      .then(async (res) => {
        if (!res.ok) {throw new Error(`Failed to load report: HTTP ${res.status}`);}
        const data = await res.json();
        if (cancelled) {return;}
        try {
          const parsed = JSON.parse(data.content) as ReportConfig;
          setConfig(parsed);
        } catch {
          throw new Error("Invalid report JSON");
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setConfigError(err instanceof Error ? err.message : "Failed to load report");
        }
      })
      .finally(() => {
        if (!cancelled) {setConfigLoading(false);}
      });

    return () => { cancelled = true; };
  }, [propConfig, reportPath]);

  // Execute all panel SQL queries when config or filters change
  const executeAllPanels = useCallback(async () => {
    if (!config) {return;}

    const filterEntries = buildFilterEntries(filterState, config.filters ?? []);

    // Mark all panels as loading
    const initialState: Record<string, PanelData> = {};
    for (const panel of config.panels) {
      initialState[panel.id] = { panelId: panel.id, rows: [], loading: true };
    }
    setPanelData(initialState);

    // Execute all panels in parallel
    await Promise.all(
      config.panels.map(async (panel) => {
        try {
          const res = await fetch("/api/workspace/reports/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sql: panel.sql,
              filters: filterEntries.length > 0 ? filterEntries : undefined,
            }),
          });

          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            setPanelData((prev) => ({
              ...prev,
              [panel.id]: {
                panelId: panel.id,
                rows: [],
                loading: false,
                error: data.error || `HTTP ${res.status}`,
              },
            }));
            return;
          }

          const data = await res.json();
          setPanelData((prev) => ({
            ...prev,
            [panel.id]: {
              panelId: panel.id,
              rows: data.rows ?? [],
              loading: false,
            },
          }));
        } catch (err) {
          setPanelData((prev) => ({
            ...prev,
            [panel.id]: {
              panelId: panel.id,
              rows: [],
              loading: false,
              error: err instanceof Error ? err.message : "Query failed",
            },
          }));
        }
      }),
    );
  }, [config, filterState]);

  // Re-execute when config, filters, or refresh key changes
  useEffect(() => {
    void executeAllPanels();
  }, [executeAllPanels, refreshKey]);

  const totalRows = useMemo(() => {
    return Object.values(panelData).reduce((sum, pd) => sum + pd.rows.length, 0);
  }, [panelData]);

  // --- Loading state ---
  if (configLoading) {
    return (
      <div className="flex items-center justify-center h-full gap-3">
        <div
          className="w-5 h-5 border-2 rounded-full animate-spin"
          style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
        />
        <span className="text-sm" style={{ color: "var(--color-text-muted)" }}>
          Loading report...
        </span>
      </div>
    );
  }

  // --- Error state ---
  if (configError) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
        <ChartBarIcon size={48} />
        <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
          Failed to load report
        </p>
        <p
          className="text-xs px-3 py-2 rounded-lg max-w-md text-center"
          style={{ background: "var(--color-surface)", color: "#f87171" }}
        >
          {configError}
        </p>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
          No report configuration found
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Report header */}
      <div
        className="px-6 py-4 border-b flex-shrink-0"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2.5 mb-1">
              <span style={{ color: "var(--color-accent)" }}>
                <ChartBarIcon />
              </span>
              <h1
                className="text-xl font-bold"
                style={{ color: "var(--color-text)" }}
              >
                {config.title}
              </h1>
            </div>
            {config.description && (
              <p
                className="text-sm ml-7"
                style={{ color: "var(--color-text-muted)" }}
              >
                {config.description}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span
              className="text-[10px] px-2 py-1 rounded-full"
              style={{
                background: "var(--color-surface)",
                color: "var(--color-text-muted)",
                border: "1px solid var(--color-border)",
              }}
            >
              {config.panels.length} panel{config.panels.length !== 1 ? "s" : ""}
            </span>
            <span
              className="text-[10px] px-2 py-1 rounded-full"
              style={{
                background: "var(--color-surface)",
                color: "var(--color-text-muted)",
                border: "1px solid var(--color-border)",
              }}
            >
              {totalRows} rows
            </span>
            <button
              type="button"
              onClick={() => setRefreshKey((k) => k + 1)}
              className="p-1.5 rounded-md transition-colors cursor-pointer"
              style={{ color: "var(--color-text-muted)" }}
              title="Refresh data"
            >
              <RefreshIcon />
            </button>
          </div>
        </div>
      </div>

      {/* Filters */}
      {config.filters && config.filters.length > 0 && (
        <FilterBar
          filters={config.filters}
          value={filterState}
          onChange={setFilterState}
        />
      )}

      {/* Panel grid */}
      <div className="flex-1 overflow-y-auto p-3 sm:p-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 sm:gap-5">
          {config.panels.map((panel) => (
            <PanelCard
              key={panel.id}
              panel={panel}
              data={panelData[panel.id]}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// --- Individual panel card ---

function PanelCard({
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
      {/* Panel header */}
      <div className="px-4 py-3 flex items-center justify-between">
        <h3
          className="text-sm font-medium"
          style={{ color: "var(--color-text)" }}
        >
          {panel.title}
        </h3>
        {data && !data.loading && !data.error && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ color: "var(--color-text-muted)" }}
          >
            {data.rows.length} rows
          </span>
        )}
      </div>

      {/* Chart area */}
      <div className="px-2 pb-3">
        {data?.loading ? (
          <div
            className="flex items-center justify-center"
            style={{ height: 320 }}
          >
            <div
              className="w-5 h-5 border-2 rounded-full animate-spin"
              style={{
                borderColor: "var(--color-border)",
                borderTopColor: "var(--color-accent)",
              }}
            />
          </div>
        ) : data?.error ? (
          <div
            className="flex flex-col items-center justify-center gap-2"
            style={{ height: 320 }}
          >
            <p className="text-xs" style={{ color: "#f87171" }}>
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
