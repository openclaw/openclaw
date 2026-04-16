import { readdirSync, readFileSync, existsSync, type Dirent } from "node:fs";
import { join } from "node:path";
import {
  resolveWorkspaceRoot,
  parseSimpleYaml,
  duckdbQueryAllAsync,
  discoverDuckDBPaths,
  duckdbQueryOnFileAsync,
  isDatabaseFile,
  pivotViewIdentifier,
} from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Safely convert an unknown DB value to a display string. */
function dbStr(val: unknown): string {
  if (val == null) {return "";}
  if (typeof val === "object") {return JSON.stringify(val);}
  return String(val as string | number | boolean);
}

// --- Types ---

export type SearchIndexItem = {
  /** Unique key: relative path for files, entryId for entries */
  id: string;
  /** Primary display text (filename or display-field value) */
  label: string;
  /** Secondary text (path for files, object name for entries) */
  sublabel?: string;
  /** Item kind for grouping and icons */
  kind: "file" | "object" | "entry";
  /** Icon hint */
  icon?: string;

  // Entry-specific
  objectName?: string;
  entryId?: string;
  /** First few field key-value pairs for search and preview */
  fields?: Record<string, string>;

  // File/object-specific
  path?: string;
  nodeType?: "document" | "folder" | "file" | "report" | "database";
  defaultView?: "table" | "kanban";
};

// --- DB types ---

type ObjectRow = {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  default_view?: string;
  display_field?: string;
};

type FieldRow = {
  id: string;
  name: string;
  type: string;
  sort_order?: number;
};

type EavRow = {
  entry_id: string;
  created_at: string;
  updated_at: string;
  field_name: string;
  value: string | null;
};

// --- Helpers ---

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

/** Determine the display field (same heuristic as the objects route). */
function resolveDisplayField(obj: ObjectRow, fields: FieldRow[]): string {
  if (obj.display_field) {return obj.display_field;}

  const nameField = fields.find(
    (f) => /\bname\b/i.test(f.name) || /\btitle\b/i.test(f.name),
  );
  if (nameField) {return nameField.name;}

  const textField = fields.find((f) => f.type === "text");
  if (textField) {return textField.name;}

  return fields[0]?.name ?? "id";
}

/** Flatten a tree recursively to produce file/object search items. */
function flattenTree(
  absDir: string,
  relBase: string,
  dbObjects: Map<string, ObjectRow>,
  items: SearchIndexItem[],
) {
  let entries: Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {continue;}

    const absPath = join(absDir, entry.name);
    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const dbObj = dbObjects.get(entry.name);
      // Check for .object.yaml
      const yamlPath = join(absPath, ".object.yaml");
      const hasYaml = existsSync(yamlPath);

      if (dbObj || hasYaml) {
        let icon: string | undefined;
        if (hasYaml) {
          try {
            const parsed = parseSimpleYaml(
              readFileSync(yamlPath, "utf-8"),
            );
            icon = parsed.icon as string | undefined;
          } catch {
            // ignore
          }
        }

        items.push({
          id: relPath,
          label: entry.name,
          sublabel: relPath,
          kind: "object",
          icon: icon ?? dbObj?.icon,
          path: relPath,
          nodeType: undefined,
          defaultView: (dbObj?.default_view === "kanban" ? "kanban" : "table") as "table" | "kanban",
        });
      } else {
        // Regular folder -- don't add as item, but recurse
      }

      flattenTree(absPath, relPath, dbObjects, items);
    } else if (entry.isFile()) {
      const isReport = entry.name.endsWith(".report.json");
      const ext = entry.name.split(".").pop()?.toLowerCase();
      const isDocument = ext === "md" || ext === "mdx";
      const isDatabase = isDatabaseFile(entry.name);

      items.push({
        id: relPath,
        label: entry.name,
        sublabel: relPath,
        kind: "file",
        path: relPath,
        nodeType: isReport
          ? "report"
          : isDatabase
            ? "database"
            : isDocument
              ? "document"
              : "file",
      });
    }
  }
}

/**
 * Fetch all entries from all objects across ALL discovered DuckDB files.
 * Deduplicates objects by name (shallower DBs win).
 */
async function buildEntryItems(): Promise<SearchIndexItem[]> {
  const items: SearchIndexItem[] = [];
  const dbPaths = discoverDuckDBPaths();
  if (dbPaths.length === 0) {return [];}

  // Collect all objects across DBs, deduplicating by name (shallowest wins)
  const seenNames = new Set<string>();
  const objectsWithDb: Array<{ obj: ObjectRow; dbPath: string }> = [];

  for (const dbPath of dbPaths) {
    const objs = await duckdbQueryOnFileAsync<ObjectRow>(dbPath,
      "SELECT * FROM objects ORDER BY name",
    );
    for (const obj of objs) {
      if (seenNames.has(obj.name)) {continue;}
      seenNames.add(obj.name);
      objectsWithDb.push({ obj, dbPath });
    }
  }

  for (const { obj, dbPath } of objectsWithDb) {
    const fields = await duckdbQueryOnFileAsync<FieldRow>(dbPath,
      `SELECT * FROM fields WHERE object_id = '${sqlEscape(obj.id)}' ORDER BY sort_order`,
    );
    const displayField = resolveDisplayField(obj, fields);
    const previewFields = fields
      .filter((f) => !["relation", "richtext"].includes(f.type))
      .slice(0, 4);

    // Try PIVOT view first, then raw EAV (on the same DB).
    // Use pivotViewIdentifier so object names with hyphens (e.g. "ai-agent")
    // resolve to the correct quoted identifier ("v_ai_agent") instead of
    // producing invalid SQL.
    let entries: Record<string, unknown>[] = await duckdbQueryOnFileAsync(dbPath,
      `SELECT * FROM ${pivotViewIdentifier(obj.name)} ORDER BY created_at DESC LIMIT 500`,
    );

    if (entries.length === 0) {
      const rawRows = await duckdbQueryOnFileAsync<EavRow>(dbPath,
        `SELECT e.id as entry_id, e.created_at, e.updated_at,
                f.name as field_name, ef.value
         FROM entries e
         JOIN entry_fields ef ON ef.entry_id = e.id
         JOIN fields f ON f.id = ef.field_id
         WHERE e.object_id = '${sqlEscape(obj.id)}'
         ORDER BY e.created_at DESC
         LIMIT 2500`,
      );

      const grouped = new Map<string, Record<string, unknown>>();
      for (const row of rawRows) {
        let entry = grouped.get(row.entry_id);
        if (!entry) {
          entry = { entry_id: row.entry_id };
          grouped.set(row.entry_id, entry);
        }
        if (row.field_name) {entry[row.field_name] = row.value;}
      }
      entries = Array.from(grouped.values());
    }

    for (const entry of entries) {
      const entryId = dbStr(entry.entry_id);
      if (!entryId) {continue;}

      const displayValue = dbStr(entry[displayField]);
      const fieldPreview: Record<string, string> = {};
      for (const f of previewFields) {
        const val = entry[f.name];
        if (val != null && val !== "") {
          fieldPreview[f.name] = dbStr(val);
        }
      }

      items.push({
        id: `entry:${obj.name}:${entryId}`,
        label: displayValue || `(${obj.name} entry)`,
        sublabel: obj.name,
        kind: "entry",
        icon: obj.icon,
        objectName: obj.name,
        entryId,
        fields: Object.keys(fieldPreview).length > 0 ? fieldPreview : undefined,
      });
    }
  }

  return items;
}

// --- Route handler ---

export async function GET() {
  const items: SearchIndexItem[] = [];

  // 1. Files + objects from tree
  const root = resolveWorkspaceRoot();
  if (root) {
    // Aggregate objects from ALL discovered DuckDB files (shallower wins)
    const dbObjects = new Map<string, ObjectRow>();
    const objs = await duckdbQueryAllAsync<ObjectRow & { name: string }>(
      "SELECT * FROM objects",
      "name",
    );
    for (const o of objs) {dbObjects.set(o.name, o);}

    // Scan workspace root (the workspace folder IS the knowledge base)
    flattenTree(root, "", dbObjects, items);
  }

  // 2. Entries from all objects across all discovered DBs
  const dbPaths = discoverDuckDBPaths();
  if (dbPaths.length > 0) {
    items.push(...await buildEntryItems());
  }

  return Response.json({ items });
}
