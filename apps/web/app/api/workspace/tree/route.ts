import { readdirSync, readFileSync, existsSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { resolveDenchRoot, parseSimpleYaml, duckdbQuery, isDatabaseFile } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type TreeNode = {
  name: string;
  path: string; // relative to dench/
  type: "object" | "document" | "folder" | "file" | "database";
  icon?: string;
  defaultView?: "table" | "kanban";
  children?: TreeNode[];
};

type DbObject = {
  name: string;
  icon?: string;
  default_view?: string;
};

/** Read .object.yaml metadata from a directory if it exists. */
function readObjectMeta(
  dirPath: string,
): { icon?: string; defaultView?: string } | null {
  const yamlPath = join(dirPath, ".object.yaml");
  if (!existsSync(yamlPath)) {return null;}

  try {
    const content = readFileSync(yamlPath, "utf-8");
    const parsed = parseSimpleYaml(content);
    return {
      icon: parsed.icon as string | undefined,
      defaultView: parsed.default_view as string | undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Query DuckDB for all objects so we can identify object directories
 * even when .object.yaml files are missing.
 */
function loadDbObjects(): Map<string, DbObject> {
  const map = new Map<string, DbObject>();
  const rows = duckdbQuery<DbObject>(
    "SELECT name, icon, default_view FROM objects",
  );
  for (const row of rows) {
    map.set(row.name, row);
  }
  return map;
}

/** Recursively build a tree of the knowledge/ directory. */
function buildTree(
  absDir: string,
  relativeBase: string,
  dbObjects: Map<string, DbObject>,
): TreeNode[] {
  const nodes: TreeNode[] = [];

  let entries: Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return nodes;
  }

  // Sort: directories first, then files, alphabetical within each group
  const sorted = entries
    .filter((e) => !e.name.startsWith(".") || e.name === ".object.yaml")
    .toSorted((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) {return -1;}
      if (!a.isDirectory() && b.isDirectory()) {return 1;}
      return a.name.localeCompare(b.name);
    });

  for (const entry of sorted) {
    // Skip hidden files except .object.yaml (but don't list it as a node)
    if (entry.name === ".object.yaml") {continue;}
    if (entry.name.startsWith(".")) {continue;}

    const absPath = join(absDir, entry.name);
    const relPath = relativeBase
      ? `${relativeBase}/${entry.name}`
      : entry.name;

    if (entry.isDirectory()) {
      const objectMeta = readObjectMeta(absPath);
      const dbObject = dbObjects.get(entry.name);
      const children = buildTree(absPath, relPath, dbObjects);

      if (objectMeta || dbObject) {
        // This directory represents a CRM object (from .object.yaml OR DuckDB)
        nodes.push({
          name: entry.name,
          path: relPath,
          type: "object",
          icon: objectMeta?.icon ?? dbObject?.icon,
          defaultView:
            ((objectMeta?.defaultView ?? dbObject?.default_view) as
              | "table"
              | "kanban") ?? "table",
          children: children.length > 0 ? children : undefined,
        });
      } else {
        // Regular folder
        nodes.push({
          name: entry.name,
          path: relPath,
          type: "folder",
          children: children.length > 0 ? children : undefined,
        });
      }
    } else if (entry.isFile()) {
      const ext = entry.name.split(".").pop()?.toLowerCase();
      const isDocument = ext === "md" || ext === "mdx";
      const isDatabase = isDatabaseFile(entry.name);

      nodes.push({
        name: entry.name,
        path: relPath,
        type: isDatabase ? "database" : isDocument ? "document" : "file",
      });
    }
  }

  return nodes;
}

/** Classify a top-level file's type. */
function classifyFileType(name: string): TreeNode["type"] {
  if (isDatabaseFile(name)) {return "database";}
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "md" || ext === "mdx") {return "document";}
  return "file";
}

export async function GET() {
  const root = resolveDenchRoot();
  if (!root) {
    return Response.json({ tree: [], exists: false });
  }

  // Load objects from DuckDB for smart directory detection
  const dbObjects = loadDbObjects();

  const knowledgeDir = join(root, "knowledge");
  const tree: TreeNode[] = [];

  // Build knowledge tree
  if (existsSync(knowledgeDir)) {
    tree.push(...buildTree(knowledgeDir, "knowledge", dbObjects));
  }

  // Add top-level files (WORKSPACE.md, workspace_context.yaml, workspace.duckdb, etc.)
  try {
    const topLevel = readdirSync(root, { withFileTypes: true });
    for (const entry of topLevel) {
      if (!entry.isFile()) {continue;}
      if (entry.name.startsWith(".")) {continue;}

      tree.push({
        name: entry.name,
        path: entry.name,
        type: classifyFileType(entry.name),
      });
    }
  } catch {
    // skip if root unreadable
  }

  return Response.json({ tree, exists: true });
}
