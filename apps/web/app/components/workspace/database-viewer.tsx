"use client";

import { useEffect, useState, useCallback, useMemo } from "react";

// --- Types ---

type ColumnInfo = {
  name: string;
  type: string;
  is_nullable: boolean;
};

type TableInfo = {
  table_name: string;
  column_count: number;
  estimated_row_count: number;
  columns: ColumnInfo[];
};

type SortState = {
  column: string;
  direction: "asc" | "desc";
} | null;

type DatabaseViewerProps = {
  /** Relative path to the database file within the dench workspace */
  dbPath: string;
  filename: string;
};

// --- Icons ---

function DatabaseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5V19A9 3 0 0 0 21 19V5" />
      <path d="M3 12A9 3 0 0 0 21 12" />
    </svg>
  );
}

function TableIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18" /><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" />
    </svg>
  );
}

function ViewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ColumnIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="1" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {direction === "left" ? (
        <path d="m15 18-6-6 6-6" />
      ) : (
        <path d="m9 18 6-6-6-6" />
      )}
    </svg>
  );
}

function SortIndicator({ active, direction }: { active: boolean; direction: "asc" | "desc" }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ opacity: active ? 1 : 0.25 }}
    >
      {direction === "asc" ? <path d="m5 12 7-7 7 7" /> : <path d="m19 12-7 7-7-7" />}
    </svg>
  );
}

// --- Helpers ---

function formatRowCount(n: number): string {
  if (n >= 1_000_000) {return `${(n / 1_000_000).toFixed(1)}M`;}
  if (n >= 1_000) {return `${(n / 1_000).toFixed(1)}K`;}
  return String(n);
}

/** Map DuckDB type names to short display labels + color hints */
function typeDisplay(dtype: string): { label: string; color: string } {
  const t = dtype.toUpperCase();
  if (t.includes("INT") || t.includes("BIGINT") || t.includes("SMALLINT") || t.includes("TINYINT") || t.includes("HUGEINT"))
    {return { label: "int", color: "#c084fc" };}
  if (t.includes("FLOAT") || t.includes("DOUBLE") || t.includes("DECIMAL") || t.includes("NUMERIC") || t.includes("REAL"))
    {return { label: "float", color: "#c084fc" };}
  if (t.includes("BOOL"))
    {return { label: "bool", color: "#f59e0b" };}
  if (t.includes("VARCHAR") || t.includes("TEXT") || t.includes("STRING") || t.includes("CHAR") || t === "UUID" || t === "BLOB")
    {return { label: t.includes("UUID") ? "uuid" : "text", color: "#22c55e" };}
  if (t.includes("TIMESTAMP") || t.includes("DATETIME"))
    {return { label: "timestamp", color: "#60a5fa" };}
  if (t.includes("DATE"))
    {return { label: "date", color: "#60a5fa" };}
  if (t.includes("TIME"))
    {return { label: "time", color: "#60a5fa" };}
  if (t.includes("JSON"))
    {return { label: "json", color: "#fb923c" };}
  return { label: dtype.toLowerCase(), color: "var(--color-text-muted)" };
}

// --- Main Component ---

export function DatabaseViewer({ dbPath, filename }: DatabaseViewerProps) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selected table
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  // Table data
  const [tableData, setTableData] = useState<Record<string, unknown>[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [sort, setSort] = useState<SortState>(null);

  // Pagination
  const [page, setPage] = useState(0);
  const pageSize = 100;

  // Custom SQL query
  const [queryMode, setQueryMode] = useState(false);
  const [sqlInput, setSqlInput] = useState("");
  const [queryResult, setQueryResult] = useState<Record<string, unknown>[] | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryRunning, setQueryRunning] = useState(false);

  // Schema panel toggle
  const [showSchema, setShowSchema] = useState(false);

  // Fetch table list on mount
  useEffect(() => {
    let cancelled = false;

    async function introspect() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/workspace/db/introspect?path=${encodeURIComponent(dbPath)}`,
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) {
          setTables(data.tables ?? []);
          // Auto-select first table
          if (data.tables?.length > 0) {
            setSelectedTable(data.tables[0].table_name);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to introspect database");
        }
      } finally {
        if (!cancelled) {setLoading(false);}
      }
    }

    introspect();
    return () => { cancelled = true; };
  }, [dbPath]);

  // Fetch table data when selection or page changes
  const fetchTableData = useCallback(
    async (tableName: string, offset: number) => {
      setDataLoading(true);
      try {
        const safeName = tableName.replace(/"/g, '""');
        const sql = `SELECT * FROM "${safeName}" LIMIT ${pageSize} OFFSET ${offset}`;
        const res = await fetch("/api/workspace/db/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: dbPath, sql }),
        });
        if (!res.ok) {
          setTableData([]);
          return;
        }
        const data = await res.json();
        setTableData(data.rows ?? []);
      } catch {
        setTableData([]);
      } finally {
        setDataLoading(false);
      }
    },
    [dbPath],
  );

  useEffect(() => {
    if (selectedTable) {
      setSort(null);
      fetchTableData(selectedTable, page * pageSize);
    }
  }, [selectedTable, page, fetchTableData]);

  // Run custom query
  const runQuery = useCallback(async () => {
    if (!sqlInput.trim()) {return;}
    setQueryRunning(true);
    setQueryError(null);
    setQueryResult(null);
    try {
      const res = await fetch("/api/workspace/db/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: dbPath, sql: sqlInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        setQueryError(data.error || `HTTP ${res.status}`);
      } else {
        setQueryResult(data.rows ?? []);
      }
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : "Query failed");
    } finally {
      setQueryRunning(false);
    }
  }, [dbPath, sqlInput]);

  // Get selected table info
  const selectedTableInfo = useMemo(
    () => tables.find((t) => t.table_name === selectedTable) ?? null,
    [tables, selectedTable],
  );

  // Sort client-side
  const sortedData = useMemo(() => {
    const data = queryMode && queryResult ? queryResult : tableData;
    if (!sort) {return data;}
    return [...data].toSorted((a, b) => {
      const aVal = String(a[sort.column] ?? "");
      const bVal = String(b[sort.column] ?? "");
      const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
      return sort.direction === "asc" ? cmp : -cmp;
    });
  }, [queryMode, queryResult, tableData, sort]);

  const handleSort = (column: string) => {
    setSort((prev) => {
      if (prev?.column === column) {
        return prev.direction === "asc"
          ? { column, direction: "desc" }
          : null;
      }
      return { column, direction: "asc" };
    });
  };

  // Derive columns from data
  const dataColumns = useMemo(() => {
    const data = queryMode && queryResult ? queryResult : tableData;
    if (data.length === 0) {return [];}
    return Object.keys(data[0]);
  }, [queryMode, queryResult, tableData]);

  // Detect database engine from filename
  const dbEngine = useMemo(() => {
    const ext = filename.split(".").pop()?.toLowerCase();
    if (ext === "duckdb") {return "DuckDB";}
    if (ext === "sqlite" || ext === "sqlite3") {return "SQLite";}
    if (ext === "postgres") {return "PostgreSQL";}
    if (ext === "db") {return "Database";}
    return "Database";
  }, [filename]);

  // --- Loading state ---
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-3">
        <div
          className="w-5 h-5 border-2 rounded-full animate-spin"
          style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
        />
        <span className="text-sm" style={{ color: "var(--color-text-muted)" }}>
          Loading database...
        </span>
      </div>
    );
  }

  // --- Error state ---
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
        <DatabaseIcon size={48} />
        <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
          Failed to open database
        </p>
        <p
          className="text-xs px-3 py-2 rounded-lg max-w-md text-center"
          style={{ background: "var(--color-surface)", color: "#f87171" }}
        >
          {error}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Left panel: Table list */}
      <div
        className="w-56 flex-shrink-0 border-r flex flex-col overflow-hidden"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      >
        {/* Database header */}
        <div className="px-3 py-3 border-b flex items-center gap-2" style={{ borderColor: "var(--color-border)" }}>
          <span style={{ color: "var(--color-accent)" }}>
            <DatabaseIcon size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium truncate" style={{ color: "var(--color-text)" }}>
              {filename}
            </div>
            <div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
              {dbEngine} &middot; {tables.length} table{tables.length !== 1 ? "s" : ""}
            </div>
          </div>
        </div>

        {/* Table list */}
        <div className="flex-1 overflow-y-auto py-1">
          {tables.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs" style={{ color: "var(--color-text-muted)" }}>
              No tables found
            </div>
          ) : (
            tables.map((t) => {
              const isView = t.table_name.startsWith("v_");
              const isActive = selectedTable === t.table_name;
              return (
                <button
                  type="button"
                  key={t.table_name}
                  onClick={() => {
                    setSelectedTable(t.table_name);
                    setPage(0);
                    setQueryMode(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors duration-75 cursor-pointer"
                  style={{
                    background: isActive ? "var(--color-surface-hover)" : "transparent",
                    color: isActive ? "var(--color-text)" : "var(--color-text-muted)",
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {(e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";}
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {(e.currentTarget as HTMLElement).style.background = "transparent";}
                  }}
                >
                  <span className="flex-shrink-0" style={{ color: isView ? "#60a5fa" : "var(--color-accent)" }}>
                    {isView ? <ViewIcon /> : <TableIcon />}
                  </span>
                  <span className="truncate flex-1">{t.table_name}</span>
                  <span className="flex-shrink-0 text-[10px] tabular-nums" style={{ color: "var(--color-text-muted)" }}>
                    {formatRowCount(t.estimated_row_count)}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Query mode toggle */}
        <div className="px-3 py-2 border-t" style={{ borderColor: "var(--color-border)" }}>
          <button
            type="button"
            onClick={() => setQueryMode(!queryMode)}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition-colors duration-100 cursor-pointer"
            style={{
              background: queryMode ? "rgba(232, 93, 58, 0.15)" : "var(--color-surface-hover)",
              color: queryMode ? "var(--color-accent)" : "var(--color-text-muted)",
              border: `1px solid ${queryMode ? "var(--color-accent)" : "var(--color-border)"}`,
            }}
          >
            <PlayIcon />
            SQL Query
          </button>
        </div>
      </div>

      {/* Right panel: Data / Query */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {queryMode ? (
          <QueryPanel
            sqlInput={sqlInput}
            setSqlInput={setSqlInput}
            queryResult={queryResult}
            queryError={queryError}
            queryRunning={queryRunning}
            runQuery={runQuery}
            dataColumns={dataColumns}
            sortedData={sortedData}
            sort={sort}
            onSort={handleSort}
          />
        ) : selectedTableInfo ? (
          <TableDataPanel
            table={selectedTableInfo}
            data={sortedData}
            dataLoading={dataLoading}
            dataColumns={dataColumns}
            sort={sort}
            onSort={handleSort}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
            showSchema={showSchema}
            onToggleSchema={() => setShowSchema(!showSchema)}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
              Select a table to view its data
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Table Data Panel ---

function TableDataPanel({
  table,
  data,
  dataLoading,
  dataColumns,
  sort,
  onSort,
  page,
  pageSize,
  onPageChange,
  showSchema,
  onToggleSchema,
}: {
  table: TableInfo;
  data: Record<string, unknown>[];
  dataLoading: boolean;
  dataColumns: string[];
  sort: SortState;
  onSort: (col: string) => void;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  showSchema: boolean;
  onToggleSchema: () => void;
}) {
  const totalRows = table.estimated_row_count;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

  return (
    <div className="flex flex-col h-full">
      {/* Table header bar */}
      <div
        className="flex items-center gap-3 px-4 py-2.5 border-b flex-shrink-0"
        style={{ borderColor: "var(--color-border)" }}
      >
        <span style={{ color: "var(--color-accent)" }}>
          <TableIcon />
        </span>
        <span className="text-sm font-medium" style={{ color: "var(--color-text)" }}>
          {table.table_name}
        </span>

        {/* Stats */}
        <div className="flex items-center gap-2 ml-auto">
          <span
            className="text-[10px] px-2 py-0.5 rounded-full"
            style={{
              background: "var(--color-surface)",
              color: "var(--color-text-muted)",
              border: "1px solid var(--color-border)",
            }}
          >
            {table.estimated_row_count.toLocaleString()} rows
          </span>
          <span
            className="text-[10px] px-2 py-0.5 rounded-full"
            style={{
              background: "var(--color-surface)",
              color: "var(--color-text-muted)",
              border: "1px solid var(--color-border)",
            }}
          >
            {table.column_count} columns
          </span>
          <button
            type="button"
            onClick={onToggleSchema}
            className="text-[10px] px-2 py-0.5 rounded-full cursor-pointer transition-colors duration-100"
            style={{
              background: showSchema ? "rgba(96, 165, 250, 0.15)" : "var(--color-surface)",
              color: showSchema ? "#60a5fa" : "var(--color-text-muted)",
              border: `1px solid ${showSchema ? "#60a5fa" : "var(--color-border)"}`,
            }}
          >
            Schema
          </button>
        </div>
      </div>

      {/* Schema panel (collapsible) */}
      {showSchema && (
        <div
          className="px-4 py-3 border-b overflow-x-auto flex-shrink-0"
          style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
        >
          <div className="flex flex-wrap gap-x-6 gap-y-1.5">
            {table.columns.map((col) => {
              const display = typeDisplay(col.type);
              return (
                <div key={col.name} className="flex items-center gap-1.5 text-xs">
                  <span style={{ color: "var(--color-text-muted)" }}>
                    <ColumnIcon />
                  </span>
                  <span className="font-medium" style={{ color: "var(--color-text)" }}>
                    {col.name}
                  </span>
                  <span
                    className="px-1 py-px rounded text-[10px]"
                    style={{ background: `${display.color}18`, color: display.color }}
                  >
                    {display.label}
                  </span>
                  {col.is_nullable && (
                    <span className="text-[10px]" style={{ color: "var(--color-text-muted)", opacity: 0.5 }}>
                      null
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Data table */}
      <div className="flex-1 overflow-auto relative">
        {dataLoading ? (
          <div className="flex items-center justify-center h-32">
            <div
              className="w-5 h-5 border-2 rounded-full animate-spin"
              style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
            />
          </div>
        ) : data.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-2">
            <span style={{ color: "var(--color-text-muted)", opacity: 0.4 }}>
              <TableIcon />
            </span>
            <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
              No data
            </p>
          </div>
        ) : (
          <DataTable
            columns={dataColumns}
            rows={data}
            sort={sort}
            onSort={onSort}
            schemaColumns={table.columns}
          />
        )}
      </div>

      {/* Pagination */}
      {totalRows > pageSize && (
        <div
          className="flex items-center justify-between px-4 py-2 border-t flex-shrink-0"
          style={{ borderColor: "var(--color-border)" }}
        >
          <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            Page {page + 1} of {totalPages}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => onPageChange(page - 1)}
              className="p-1 rounded transition-colors duration-100 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ color: "var(--color-text-muted)" }}
            >
              <ChevronIcon direction="left" />
            </button>
            <button
              type="button"
              disabled={page >= totalPages - 1}
              onClick={() => onPageChange(page + 1)}
              className="p-1 rounded transition-colors duration-100 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ color: "var(--color-text-muted)" }}
            >
              <ChevronIcon direction="right" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Query Panel ---

function QueryPanel({
  sqlInput,
  setSqlInput,
  queryResult,
  queryError,
  queryRunning,
  runQuery,
  dataColumns,
  sortedData,
  sort,
  onSort,
}: {
  sqlInput: string;
  setSqlInput: (v: string) => void;
  queryResult: Record<string, unknown>[] | null;
  queryError: string | null;
  queryRunning: boolean;
  runQuery: () => void;
  dataColumns: string[];
  sortedData: Record<string, unknown>[];
  sort: SortState;
  onSort: (col: string) => void;
}) {
  return (
    <div className="flex flex-col h-full">
      {/* SQL input */}
      <div
        className="px-4 py-3 border-b flex-shrink-0"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <textarea
              value={sqlInput}
              onChange={(e) => setSqlInput(e.target.value)}
              placeholder="SELECT * FROM table_name LIMIT 100"
              className="w-full text-xs rounded-lg px-3 py-2 resize-none outline-none"
              style={{
                background: "var(--color-surface)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border)",
                fontFamily: "'SF Mono', 'Fira Code', 'JetBrains Mono', monospace",
                minHeight: "60px",
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  runQuery();
                }
              }}
            />
            <div className="text-[10px] mt-1" style={{ color: "var(--color-text-muted)" }}>
              Press Cmd+Enter to run
            </div>
          </div>
          <button
            type="button"
            onClick={runQuery}
            disabled={queryRunning || !sqlInput.trim()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors duration-100 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: "var(--color-accent)",
              color: "white",
            }}
          >
            {queryRunning ? (
              <div
                className="w-3.5 h-3.5 border-2 rounded-full animate-spin"
                style={{ borderColor: "rgba(255,255,255,0.3)", borderTopColor: "white" }}
              />
            ) : (
              <PlayIcon />
            )}
            Run
          </button>
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-auto">
        {queryError && (
          <div className="px-4 py-3">
            <div
              className="px-3 py-2 rounded-lg text-xs"
              style={{ background: "rgba(248, 113, 113, 0.1)", color: "#f87171", border: "1px solid rgba(248, 113, 113, 0.2)" }}
            >
              {queryError}
            </div>
          </div>
        )}

        {queryResult !== null && queryResult.length === 0 && !queryError && (
          <div className="flex items-center justify-center py-12">
            <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
              Query returned no results
            </p>
          </div>
        )}

        {queryResult !== null && queryResult.length > 0 && (
          <>
            <div className="px-4 py-1.5">
              <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                {queryResult.length} row{queryResult.length !== 1 ? "s" : ""}
              </span>
            </div>
            <DataTable
              columns={dataColumns}
              rows={sortedData}
              sort={sort}
              onSort={onSort}
            />
          </>
        )}

        {queryResult === null && !queryError && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <span style={{ color: "var(--color-text-muted)", opacity: 0.3 }}>
              <PlayIcon />
            </span>
            <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
              Write a SQL query and press Run
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Shared Data Table ---

function DataTable({
  columns,
  rows,
  sort,
  onSort,
  schemaColumns,
}: {
  columns: string[];
  rows: Record<string, unknown>[];
  sort: SortState;
  onSort: (col: string) => void;
  schemaColumns?: ColumnInfo[];
}) {
  return (
    <table
      className="w-full text-xs"
      style={{ borderCollapse: "separate", borderSpacing: 0 }}
    >
      <thead>
        <tr>
          {/* Row number column */}
          <th
            className="text-right px-2 py-2 font-normal whitespace-nowrap border-b sticky top-0 z-[1]"
            style={{
              color: "var(--color-text-muted)",
              borderColor: "var(--color-border)",
              background: "var(--color-surface)",
              width: "2.5rem",
              opacity: 0.5,
            }}
          >
            #
          </th>
          {columns.map((col) => {
            const schema = schemaColumns?.find((c) => c.name === col);
            const display = schema ? typeDisplay(schema.type) : null;
            return (
              <th
                key={col}
                className="text-left px-3 py-2 font-medium whitespace-nowrap border-b cursor-pointer select-none sticky top-0 z-[1]"
                style={{
                  color: "var(--color-text-muted)",
                  borderColor: "var(--color-border)",
                  background: "var(--color-surface)",
                }}
                onClick={() => onSort(col)}
              >
                <span className="flex items-center gap-1">
                  {col}
                  {display && (
                    <span
                      className="text-[9px] px-1 rounded"
                      style={{ color: display.color, opacity: 0.6 }}
                    >
                      {display.label}
                    </span>
                  )}
                  <SortIndicator
                    active={sort?.column === col}
                    direction={sort?.column === col ? sort.direction : "asc"}
                  />
                </span>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, idx) => (
          <tr
            key={idx}
            className="transition-colors duration-75 group"
            style={{
              background: idx % 2 === 0 ? "transparent" : "var(--color-surface)",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background =
                idx % 2 === 0 ? "transparent" : "var(--color-surface)";
            }}
          >
            {/* Row number */}
            <td
              className="text-right px-2 py-1.5 border-b tabular-nums"
              style={{
                color: "var(--color-text-muted)",
                borderColor: "var(--color-border)",
                opacity: 0.4,
              }}
            >
              {idx + 1}
            </td>
            {columns.map((col) => (
              <td
                key={col}
                className="px-3 py-1.5 border-b whitespace-nowrap"
                style={{ borderColor: "var(--color-border)", color: "var(--color-text)" }}
              >
                <CellContent value={row[col]} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --- Cell content renderer ---

function CellContent({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return (
      <span style={{ color: "var(--color-text-muted)", opacity: 0.4, fontStyle: "italic" }}>
        null
      </span>
    );
  }

  if (typeof value === "boolean") {
    return (
      <span style={{ color: value ? "#22c55e" : "#f87171" }}>
        {value ? "true" : "false"}
      </span>
    );
  }

  if (typeof value === "number") {
    return <span className="tabular-nums">{value}</span>;
  }

  const str = String(value);

  // Truncate very long values
  if (str.length > 120) {
    return (
      <span title={str} className="cursor-help">
        {str.slice(0, 120)}
        <span style={{ color: "var(--color-text-muted)" }}>...</span>
      </span>
    );
  }

  return <span>{str}</span>;
}
