import { safeResolvePath, duckdbQueryOnFile } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type TableInfo = {
  table_name: string;
  column_count: number;
  estimated_row_count: number;
  columns: Array<{
    name: string;
    type: string;
    is_nullable: boolean;
  }>;
};

/**
 * GET /api/workspace/db/introspect?path=<relative-path>
 *
 * Introspects a DuckDB / SQLite / generic DB file using the duckdb CLI.
 * Returns the list of tables with their columns and approximate row counts.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const relPath = searchParams.get("path");

  if (!relPath) {
    return Response.json(
      { error: "Missing required `path` query parameter" },
      { status: 400 },
    );
  }

  const absPath = safeResolvePath(relPath);
  if (!absPath) {
    return Response.json(
      { error: "File not found or path traversal rejected" },
      { status: 404 },
    );
  }

  // Get all user tables (skip internal DuckDB catalogs)
  const rawTables = duckdbQueryOnFile<{
    table_name: string;
    table_type: string;
  }>(
    absPath,
    "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name",
  );

  if (rawTables.length === 0) {
    return Response.json({ tables: [], path: relPath });
  }

  const tables: TableInfo[] = [];

  for (const t of rawTables) {
    // Fetch columns for this table
    const cols = duckdbQueryOnFile<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      absPath,
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'main' AND table_name = '${t.table_name.replace(/'/g, "''")}' ORDER BY ordinal_position`,
    );

    // Get approximate row count
    let rowCount = 0;
    try {
      const countResult = duckdbQueryOnFile<{ cnt: number }>(
        absPath,
        `SELECT count(*) as cnt FROM "${t.table_name.replace(/"/g, '""')}"`,
      );
      rowCount = countResult[0]?.cnt ?? 0;
    } catch {
      // skip if we can't count
    }

    tables.push({
      table_name: t.table_name,
      column_count: cols.length,
      estimated_row_count: rowCount,
      columns: cols.map((c) => ({
        name: c.column_name,
        type: c.data_type,
        is_nullable: c.is_nullable === "YES",
      })),
    });
  }

  return Response.json({ tables, path: relPath });
}
