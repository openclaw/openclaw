import { safeResolvePath, duckdbQueryOnFile } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/workspace/db/query
 * Body: { path: string, sql: string }
 *
 * Executes a read-only SQL query against a database file and returns JSON rows.
 * Only SELECT statements are allowed for safety.
 */
export async function POST(request: Request) {
  let body: { path?: string; sql?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { path: relPath, sql } = body;

  if (!relPath || !sql) {
    return Response.json(
      { error: "Missing required `path` and `sql` fields" },
      { status: 400 },
    );
  }

  // Basic safety: only allow SELECT-like statements
  const trimmedSql = sql.trim().toUpperCase();
  if (
    !trimmedSql.startsWith("SELECT") &&
    !trimmedSql.startsWith("PRAGMA") &&
    !trimmedSql.startsWith("DESCRIBE") &&
    !trimmedSql.startsWith("SHOW") &&
    !trimmedSql.startsWith("EXPLAIN") &&
    !trimmedSql.startsWith("WITH")
  ) {
    return Response.json(
      { error: "Only read-only queries (SELECT, DESCRIBE, SHOW, EXPLAIN, WITH) are allowed" },
      { status: 403 },
    );
  }

  const absPath = safeResolvePath(relPath);
  if (!absPath) {
    return Response.json(
      { error: "File not found or path traversal rejected" },
      { status: 404 },
    );
  }

  const rows = duckdbQueryOnFile(absPath, sql);
  return Response.json({ rows, sql });
}
