import {
  duckdbPathAsync,
  parseRelationValue,
  resolveDuckdbBin,
  duckdbQueryOnFileAsync,
  duckdbQueryOnFileAsyncStrict,
  pivotViewIdentifier,
  discoverDuckDBPathsAsync,
  getObjectViews,
  duckdbExecOnFileAsync,
} from "@/lib/workspace";
import { deserializeFilters, buildWhereClause, buildOrderByClause, type FieldMeta } from "@/lib/object-filters";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ObjectRow = {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  default_view?: string;
  display_field?: string;
  immutable?: boolean;
  created_at?: string;
  updated_at?: string;
};

type FieldRow = {
  id: string;
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  enum_values?: string;
  enum_colors?: string;
  enum_multiple?: boolean;
  related_object_id?: string;
  relationship_type?: string;
  sort_order?: number;
};

type StatusRow = {
  id: string;
  name: string;
  color?: string;
  sort_order?: number;
  is_default?: boolean;
};

type EavRow = {
  entry_id: string;
  created_at: string;
  updated_at: string;
  field_name: string;
  value: string | null;
};

// --- Schema migration (idempotent, runs once per process) ---

const migratedDbs = new Map<string, Promise<void>>();

/** Ensure the display_field column exists on a specific DB file. */
async function ensureDisplayFieldColumn(dbFile: string): Promise<void> {
  const existing = migratedDbs.get(dbFile);
  if (existing) {return existing;}
  const promise = duckdbExecOnFileAsync(
    dbFile,
    "ALTER TABLE objects ADD COLUMN IF NOT EXISTS display_field VARCHAR",
  ).then(() => undefined);
  migratedDbs.set(dbFile, promise);
  return promise;
}

// --- Helpers ---

/** Scoped query helper: queries a specific DB file. */
async function q<T = Record<string, unknown>>(dbFile: string, sql: string): Promise<T[]> {
  return duckdbQueryOnFileAsync<T>(dbFile, sql);
}

/**
 * Pivot raw EAV rows into one object per entry with field names as keys.
 */
function pivotEavRows(rows: EavRow[]): Record<string, unknown>[] {
  const grouped = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    let entry = grouped.get(row.entry_id);
    if (!entry) {
      entry = {
        entry_id: row.entry_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
      grouped.set(row.entry_id, entry);
    }
    if (row.field_name) {
      entry[row.field_name] = row.value;
    }
  }

  return Array.from(grouped.values());
}

function tryParseJson(value: unknown): unknown {
  if (typeof value !== "string") {return value;}
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** SQL-escape a string (double single-quotes). */
function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Find both the DB file and object row, retrying once for transient DuckDB misses.
 * This avoids a false 404 when the existence probe or row fetch briefly returns [].
 */
async function findObjectRecord(
  objectName: string,
): Promise<{ dbFile: string; object: ObjectRow } | null> {
  const dbPaths = await discoverDuckDBPathsAsync();
  if (dbPaths.length === 0) {return null;}

  const objectSql = `SELECT * FROM objects WHERE name = '${sqlEscape(objectName)}' LIMIT 1`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const dbFile of dbPaths) {
      const objects = await q<ObjectRow>(dbFile, objectSql);
      if (objects.length > 0) {
        return { dbFile, object: objects[0] };
      }
    }

    if (attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return null;
}

/**
 * Determine the display field for an object.
 * Priority: explicit display_field > heuristic (name/title) > first text field > first field.
 */
function resolveDisplayField(
  obj: ObjectRow,
  objFields: FieldRow[],
): string {
  if (obj.display_field) {return obj.display_field;}

  // Heuristic: look for name/title fields
  const nameField = objFields.find(
    (f) =>
      /\bname\b/i.test(f.name) || /\btitle\b/i.test(f.name),
  );
  if (nameField) {return nameField.name;}

  // Fallback: first text field
  const textField = objFields.find((f) => f.type === "text");
  if (textField) {return textField.name;}

  // Ultimate fallback: first field
  return objFields[0]?.name ?? "id";
}

/**
 * Resolve relation field values to human-readable display labels.
 * All queries target the same DB file where the object lives.
 */
async function resolveRelationLabels(
  dbFile: string,
  fields: FieldRow[],
  entries: Record<string, unknown>[],
): Promise<{
  labels: Record<string, Record<string, string>>;
  relatedObjectNames: Record<string, string>;
}> {
  const labels: Record<string, Record<string, string>> = {};
  const relatedObjectNames: Record<string, string> = {};

  const relationFields = fields.filter(
    (f) => f.type === "relation" && f.related_object_id,
  );

  for (const rf of relationFields) {
    const relatedObjs = await q<ObjectRow>(dbFile,
      `SELECT * FROM objects WHERE id = '${sqlEscape(rf.related_object_id!)}' LIMIT 1`,
    );
    if (relatedObjs.length === 0) {continue;}
    const relObj = relatedObjs[0];
    relatedObjectNames[rf.name] = relObj.name;

    const relFields = await q<FieldRow>(dbFile,
      `SELECT * FROM fields WHERE object_id = '${sqlEscape(relObj.id)}' ORDER BY sort_order`,
    );
    const displayFieldName = resolveDisplayField(relObj, relFields);

    const entryIds = new Set<string>();
    for (const entry of entries) {
      const val = entry[rf.name];
      if (val == null || val === "") {
        continue;
      }
      const valStr =
        typeof val === "object" && val !== null
          ? JSON.stringify(val)
          : typeof val === "string"
            ? val
            : typeof val === "number" || typeof val === "boolean"
              ? String(val)
              : "";
      for (const id of parseRelationValue(valStr)) {
        entryIds.add(id);
      }
    }

    if (entryIds.size === 0) {
      labels[rf.name] = {};
      continue;
    }

    const idList = Array.from(entryIds)
      .map((id) => `'${sqlEscape(id)}'`)
      .join(",");
    const displayRows = await q<{ entry_id: string; value: string }>(dbFile,
      `SELECT e.id as entry_id, ef.value
       FROM entries e
       JOIN entry_fields ef ON ef.entry_id = e.id
       JOIN fields f ON f.id = ef.field_id
       WHERE e.id IN (${idList})
       AND f.object_id = '${sqlEscape(relObj.id)}'
       AND f.name = '${sqlEscape(displayFieldName)}'`,
    );

    const labelMap: Record<string, string> = {};
    for (const row of displayRows) {
      labelMap[row.entry_id] = row.value || row.entry_id;
    }
    for (const id of entryIds) {
      if (!labelMap[id]) {labelMap[id] = id;}
    }

    labels[rf.name] = labelMap;
  }

  return { labels, relatedObjectNames };
}

type ReverseRelation = {
  fieldName: string;
  sourceObjectName: string;
  sourceObjectId: string;
  displayField: string;
  entries: Record<string, Array<{ id: string; label: string }>>;
};

/**
 * Find reverse relations: other objects with relation fields pointing TO this object.
 * Searches across ALL discovered databases to catch cross-DB relations.
 */
async function findReverseRelations(objectId: string): Promise<ReverseRelation[]> {
  const dbPaths = await discoverDuckDBPathsAsync();
  const result: ReverseRelation[] = [];

  for (const db of dbPaths) {
    const reverseFields = await q<
      FieldRow & { source_object_id: string; source_object_name: string }
    >(db,
      `SELECT f.*, f.object_id as source_object_id, o.name as source_object_name
       FROM fields f
       JOIN objects o ON o.id = f.object_id
       WHERE f.type = 'relation'
       AND f.related_object_id = '${sqlEscape(objectId)}'`,
    );

    for (const rrf of reverseFields) {
      const sourceObjs = await q<ObjectRow>(db,
        `SELECT * FROM objects WHERE id = '${sqlEscape(rrf.source_object_id)}' LIMIT 1`,
      );
      if (sourceObjs.length === 0) {continue;}

      const sourceFields = await q<FieldRow>(db,
        `SELECT * FROM fields WHERE object_id = '${sqlEscape(rrf.source_object_id)}' ORDER BY sort_order`,
      );
      const displayFieldName = resolveDisplayField(sourceObjs[0], sourceFields);

      const refRows = await q<{ source_entry_id: string; target_value: string }>(db,
        `SELECT ef.entry_id as source_entry_id, ef.value as target_value
         FROM entry_fields ef
         WHERE ef.field_id = '${sqlEscape(rrf.id)}'
         AND ef.value IS NOT NULL
         AND ef.value != ''`,
      );

      if (refRows.length === 0) {continue;}

      const sourceEntryIds = [...new Set(refRows.map((r) => r.source_entry_id))];
      const idList = sourceEntryIds.map((id) => `'${sqlEscape(id)}'`).join(",");
      const displayRows = await q<{ entry_id: string; value: string }>(db,
        `SELECT ef.entry_id, ef.value
         FROM entry_fields ef
         JOIN fields f ON f.id = ef.field_id
         WHERE ef.entry_id IN (${idList})
         AND f.name = '${sqlEscape(displayFieldName)}'
         AND f.object_id = '${sqlEscape(rrf.source_object_id)}'`,
      );

      const displayMap: Record<string, string> = {};
      for (const row of displayRows) {
        displayMap[row.entry_id] = row.value || row.entry_id;
      }

      const entriesMap: Record<string, Array<{ id: string; label: string }>> = {};
      for (const row of refRows) {
        const targetIds = parseRelationValue(row.target_value);
        for (const targetId of targetIds) {
          if (!entriesMap[targetId]) {entriesMap[targetId] = [];}
          entriesMap[targetId].push({
            id: row.source_entry_id,
            label: displayMap[row.source_entry_id] || row.source_entry_id,
          });
        }
      }

      result.push({
        fieldName: rrf.name,
        sourceObjectName: rrf.source_object_name,
        sourceObjectId: rrf.source_object_id,
        displayField: displayFieldName,
        entries: entriesMap,
      });
    }
  }

  return result;
}

// --- Route handler ---

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;

  if (!resolveDuckdbBin()) {
    return Response.json(
      { error: "DuckDB CLI is not installed", code: "DUCKDB_NOT_INSTALLED" },
      { status: 503 },
    );
  }

  // Sanitize name to prevent injection (only allow alphanumeric + underscore + hyphen)
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
    return Response.json(
      { error: "Invalid object name" },
      { status: 400 },
    );
  }

  // Find which DuckDB file contains this object (searches all discovered DBs).
  // Query the full object row directly so a transient empty existence probe
  // does not incorrectly downgrade the request to 404.
  const objectRecord = await findObjectRecord(name);
  if (!objectRecord) {
    // Fall back to primary DB check for a friendlier error message
    if (!await duckdbPathAsync()) {
      return Response.json(
        { error: "DuckDB database not found" },
        { status: 404 },
      );
    }
    return Response.json(
      { error: `Object '${name}' not found` },
      { status: 404 },
    );
  }

  const { dbFile, object: obj } = objectRecord;

  // Ensure display_field column exists on this specific DB
  await ensureDisplayFieldColumn(dbFile);

  // Keep same-DB schema reads sequential: parallel DuckDB CLI processes against
  // one file can intermittently return empty results, which makes the object
  // page oscillate between full and partial schemas during live refreshes.
  // Retry once after a short delay if fields come back empty (DuckDB concurrency).
  let fields = await q<FieldRow>(
    dbFile,
    `SELECT * FROM fields WHERE object_id = '${obj.id}' ORDER BY sort_order`,
  );
  if (fields.length === 0) {
    await new Promise((r) => setTimeout(r, 100));
    fields = await q<FieldRow>(
      dbFile,
      `SELECT * FROM fields WHERE object_id = '${obj.id}' ORDER BY sort_order`,
    );
  }
  let statuses = await q<StatusRow>(
    dbFile,
    `SELECT * FROM statuses WHERE object_id = '${obj.id}' ORDER BY sort_order`,
  );
  if (statuses.length === 0 && fields.length > 0) {
    await new Promise((r) => setTimeout(r, 50));
    statuses = await q<StatusRow>(
      dbFile,
      `SELECT * FROM statuses WHERE object_id = '${obj.id}' ORDER BY sort_order`,
    );
  }

  // --- Parse filter/sort/pagination query params ---
  const url = new URL(_req.url);
  const filtersParam = url.searchParams.get("filters");
  const sortParam = url.searchParams.get("sort");
  const searchParam = url.searchParams.get("search");
  const pageParam = url.searchParams.get("page");
  const pageSizeParam = url.searchParams.get("pageSize");

  const filterGroup = filtersParam ? deserializeFilters(filtersParam) : undefined;
  const fieldsMeta: FieldMeta[] = fields.map((f) => ({ name: f.name, type: f.type }));

  // Build WHERE clause from filters
  let whereClause = "";
  if (filterGroup) {
    const where = buildWhereClause(filterGroup, fieldsMeta);
    if (where) {whereClause = ` WHERE ${where}`;}
  }

  // Build ORDER BY clause.
  // Keep a deterministic tie-breaker on entry_id to prevent row jitter between refreshes.
  let orderByClause = " ORDER BY created_at DESC, entry_id DESC";
  if (sortParam) {
    try {
      const sortRules = JSON.parse(sortParam);
      const orderBy = buildOrderByClause(sortRules);
      if (orderBy) {orderByClause = ` ORDER BY ${orderBy}, entry_id DESC`;}
    } catch {
      // keep default sort
    }
  }

  // Pagination
  const page = Math.max(1, Number(pageParam) || 1);
  const pageSize = Math.min(5000, Math.max(1, Number(pageSizeParam) || 100));
  const offset = (page - 1) * pageSize;
  const limitClause = ` LIMIT ${pageSize} OFFSET ${offset}`;

  // Full-text search across text fields
  if (searchParam && searchParam.trim()) {
    const textFields = fields.filter((f) => ["text", "richtext", "email"].includes(f.type));
    if (textFields.length > 0) {
      const searchConditions = textFields
        .map((f) => `LOWER(CAST("${f.name.replace(/"/g, '""')}" AS VARCHAR)) LIKE '%${sqlEscape(searchParam.toLowerCase())}%'`)
        .join(" OR ");
      whereClause = whereClause
        ? `${whereClause} AND (${searchConditions})`
        : ` WHERE (${searchConditions})`;
    }
  }

  // Try the PIVOT view first, then fall back to raw EAV query + client-side pivot.
  // IMPORTANT: use the *Strict* query variant here so DuckDB errors (e.g. missing
  // view, bad identifier from hyphenated object names, concurrency hiccups) reject
  // and actually trigger the fallback — the non-strict variant silently returns []
  // and would leave the UI stuck on "No results found" while `objects.entry_count`
  // still says otherwise.
  const viewIdent = pivotViewIdentifier(name);
  let entries: Record<string, unknown>[] = [];
  let totalCount = 0;
  let usedFallback = false;

  try {
    const countResult = await duckdbQueryOnFileAsyncStrict<{ cnt: number }>(dbFile,
      `SELECT COUNT(*) as cnt FROM ${viewIdent}${whereClause}`,
    );
    totalCount = Number(countResult[0]?.cnt ?? 0);

    let pivotEntries = await duckdbQueryOnFileAsyncStrict<Record<string, unknown>>(dbFile,
      `SELECT * FROM ${viewIdent}${whereClause}${orderByClause}${limitClause}`,
    );

    // Parallel DuckDB CLI processes against the same file can intermittently
    // return empty JSON arrays even when data exists. Retry once on the
    // obvious mismatch case (count says rows exist, first page is empty).
    if (pivotEntries.length === 0 && totalCount > 0) {
      await new Promise((r) => setTimeout(r, 120));
      pivotEntries = await duckdbQueryOnFileAsyncStrict<Record<string, unknown>>(dbFile,
        `SELECT * FROM ${viewIdent}${whereClause}${orderByClause}${limitClause}`,
      );
    }

    entries = pivotEntries;
  } catch {
    // Pivot view might not exist, may have been created with a stale schema,
    // or may fail because of a view-identifier mismatch (e.g. object renamed).
    // Fall back to reading the raw EAV tables and pivoting in JS.
    usedFallback = true;
    const rawRows = await q<EavRow>(dbFile,
      `SELECT e.id as entry_id, e.created_at, e.updated_at,
              f.name as field_name, ef.value
       FROM entries e
       JOIN entry_fields ef ON ef.entry_id = e.id
       JOIN fields f ON f.id = ef.field_id
       WHERE e.object_id = '${obj.id}'
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT 5000`,
    );
    entries = pivotEavRows(rawRows);
  }

  if (usedFallback) {
    // When falling back to raw EAV, derive totalCount from a COUNT(DISTINCT)
    // over entries (which does not depend on the pivot view existing), so the
    // UI footer / pagination match the rows the user actually sees.
    const countRows = await q<{ cnt: number }>(dbFile,
      `SELECT COUNT(*) as cnt FROM entries WHERE object_id = '${obj.id}'`,
    );
    totalCount = Number(countRows[0]?.cnt ?? entries.length);
  }

  const parsedFields = fields.map((f) => ({
    ...f,
    enum_values: f.enum_values ? tryParseJson(f.enum_values) : undefined,
    enum_colors: f.enum_colors ? tryParseJson(f.enum_colors) : undefined,
  }));

  const { labels: relationLabels, relatedObjectNames } =
    await resolveRelationLabels(dbFile, fields, entries);

  const enrichedFields = parsedFields.map((f) => ({
    ...f,
    related_object_name:
      f.type === "relation" ? relatedObjectNames[f.name] : undefined,
  }));

  const reverseRelations = await findReverseRelations(obj.id);

  const effectiveDisplayField = resolveDisplayField(obj, fields);

  // Include saved views from .object.yaml
  const { views: savedViews, activeView, viewSettings } = getObjectViews(name);

  return Response.json({
    object: obj,
    fields: enrichedFields,
    statuses,
    entries,
    relationLabels,
    reverseRelations,
    effectiveDisplayField,
    savedViews,
    activeView,
    viewSettings,
    totalCount,
    page,
    pageSize,
  });
}
